import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findTopLevelCommandToken, shouldShortCircuitTopLevelCli } from "../cli-core.js";

const FLOW_CLI_ASSET = "acpx-flow-cli";
const FLOW_RUNTIME_ASSET = "acpx-flow-runtime";
const FLOW_ESBUILD_PACKAGE_ASSET = "acpx-flow-esbuild-package";
const FLOW_ESBUILD_MAIN_ASSET = "acpx-flow-esbuild-main";
const FLOW_ESBUILD_BINARY_ASSET = "acpx-flow-esbuild-binary";
const TERMINATION_SIGNALS = ["SIGINT", "SIGTERM"] as const;
// Flow interrupt cleanup can wait 2.5s for session/cancel, then up to 3.25s
// while AcpClient closes a stubborn adapter. Keep the SEA launcher alive long
// enough for that detached adapter process group to be reaped.
const TERMINATION_GRACE_MS = 7_000;

type FlowAssetReader = (key: string) => ArrayBuffer;
type TerminationSignal = (typeof TERMINATION_SIGNALS)[number];
type ChildResult = {
  exitCode: number;
  forwardedSignal?: TerminationSignal;
};
type Failure = { error: unknown };

function signalOwnedProcess(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): boolean {
  if (child.pid === undefined) {
    return false;
  }

  try {
    if (process.platform === "win32") {
      return child.kill(signal);
    }
    process.kill(-child.pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function waitForChild(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<ChildResult> {
  return await new Promise<ChildResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      detached: process.platform !== "win32",
      env,
      stdio: "inherit",
    });
    let forwardedSignal: TerminationSignal | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const removeSignalHandlers = () => {
      for (const signal of TERMINATION_SIGNALS) {
        process.off(signal, signalHandlers[signal]);
      }
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
    };
    const forwardSignal = (signal: TerminationSignal) => {
      if (forwardedSignal) {
        return;
      }
      forwardedSignal = signal;
      signalOwnedProcess(child, signal);
      forceKillTimer = setTimeout(() => {
        signalOwnedProcess(child, "SIGKILL");
      }, TERMINATION_GRACE_MS);
    };
    const signalHandlers: Record<TerminationSignal, () => void> = {
      SIGINT: () => {
        forwardSignal("SIGINT");
      },
      SIGTERM: () => {
        forwardSignal("SIGTERM");
      },
    };

    for (const signal of TERMINATION_SIGNALS) {
      process.on(signal, signalHandlers[signal]);
    }
    child.once("error", (error) => {
      removeSignalHandlers();
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (forwardedSignal) {
        // The delegated child can exit before a same-group descendant that
        // ignored the forwarded signal. Reap the remaining owned group before
        // the launcher restores the signal's default process semantics.
        signalOwnedProcess(child, "SIGKILL");
      }
      removeSignalHandlers();
      resolve({
        exitCode: code ?? (signal ? 1 : 0),
        ...(forwardedSignal ? { forwardedSignal } : {}),
      });
    });
  });
}

function completeDelegation(
  childResult: ChildResult | undefined,
  operationFailure: Failure | undefined,
  cleanupFailure: Failure | undefined,
): true {
  if (childResult?.forwardedSignal) {
    process.exitCode = childResult.exitCode;
    process.kill(process.pid, childResult.forwardedSignal);
    return true;
  }
  if (operationFailure) {
    throw operationFailure.error;
  }
  if (cleanupFailure) {
    throw cleanupFailure.error;
  }
  if (!childResult) {
    throw new Error("SEA flow runtime ended without a result.");
  }

  process.exitCode = childResult.exitCode;
  return true;
}

export async function delegateSeaFlowCommand(
  argv: string[],
  getAsset: FlowAssetReader,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const userArgs = argv.slice(2);
  if (shouldShortCircuitTopLevelCli(userArgs) || findTopLevelCommandToken(userArgs) !== "flow") {
    return false;
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-sea-flow-"));
  const cliPath = path.join(tempDir, "cli.cjs");
  const runtimePath = path.join(tempDir, "flows.js");
  const esbuildPackageDir = path.join(tempDir, "node_modules", "esbuild");
  const esbuildMainDir = path.join(esbuildPackageDir, "lib");
  const esbuildBinaryPath = path.join(tempDir, "esbuild");
  let childResult: ChildResult | undefined;
  let operationFailure: Failure | undefined;

  try {
    await fs.mkdir(esbuildMainDir, { recursive: true });
    await Promise.all([
      fs.writeFile(cliPath, Buffer.from(getAsset(FLOW_CLI_ASSET)), { mode: 0o600 }),
      fs.writeFile(runtimePath, Buffer.from(getAsset(FLOW_RUNTIME_ASSET)), { mode: 0o600 }),
      fs.writeFile(
        path.join(esbuildPackageDir, "package.json"),
        Buffer.from(getAsset(FLOW_ESBUILD_PACKAGE_ASSET)),
        { mode: 0o600 },
      ),
      fs.writeFile(
        path.join(esbuildMainDir, "main.js"),
        Buffer.from(getAsset(FLOW_ESBUILD_MAIN_ASSET)),
        { mode: 0o600 },
      ),
      fs.writeFile(esbuildBinaryPath, Buffer.from(getAsset(FLOW_ESBUILD_BINARY_ASSET)), {
        mode: 0o700,
      }),
      fs.writeFile(path.join(tempDir, "package.json"), '{"type":"module"}\n', {
        encoding: "utf8",
        mode: 0o600,
      }),
    ]);

    childResult = await waitForChild("node", [cliPath, ...argv.slice(2)], {
      ...env,
      ACPX_FLOW_RUNTIME_PATH: runtimePath,
      ESBUILD_BINARY_PATH: esbuildBinaryPath,
    });
  } catch (error) {
    operationFailure = { error };
  }

  let cleanupFailure: Failure | undefined;
  try {
    await fs.rm(tempDir, { recursive: true, force: true });
  } catch (error) {
    cleanupFailure = { error };
  }

  return completeDelegation(childResult, operationFailure, cleanupFailure);
}
