import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { queuePaths } from "./queue-test-helpers.js";

const DIST_CLI_PATH = path.join(process.cwd(), "dist", "cli.js");
const DIST_SEA_SBOM_PATH = path.join(process.cwd(), "dist-sea", "sbom.json");
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const MOCK_AGENT_COMMAND = `node ${JSON.stringify(MOCK_AGENT_PATH)}`;

type PackageJson = {
  version?: unknown;
  bin?: {
    acpx?: unknown;
  };
};

type CliRunResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

function readPackageJson(): PackageJson {
  return JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as PackageJson;
}

function readPackageVersion(): string {
  const parsed = readPackageJson();
  const { version } = parsed;
  if (typeof version !== "string") {
    throw new Error("package.json version is missing");
  }
  return version;
}

function readPackageBinPath(): string {
  const parsed = readPackageJson();
  const binPath = parsed.bin?.acpx;
  if (typeof binPath !== "string" || binPath.length === 0) {
    throw new Error("package.json bin.acpx is missing");
  }
  return path.join(process.cwd(), binPath);
}

function packageBinSpawnArgs(args: string[]): {
  command: string;
  args: string[];
} {
  const override = process.env.ACPX_TEST_PACKAGE_BIN;
  if (override) {
    return { command: path.resolve(override), args };
  }

  const binPath = readPackageBinPath();
  if (process.platform === "win32") {
    return { command: process.execPath, args: [binPath, ...args] };
  }
  return { command: binPath, args };
}

async function withTempHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-packaged-bin-test-home-"));
  try {
    await run(tempHome);
  } finally {
    await fs.rm(tempHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

async function runPackageBin(
  args: string[],
  homeDir: string,
  timeoutMs = 15_000,
  envOverrides: NodeJS.ProcessEnv = {},
): Promise<CliRunResult> {
  return await new Promise<CliRunResult>((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: homeDir,
      ...envOverrides,
    };
    delete env.NODE_V8_COVERAGE;

    const command = packageBinSpawnArgs(args);
    const child = spawn(command.command, command.args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`packaged acpx timed out after ${timeoutMs}ms: ${args.join(" ")}`));
    }, timeoutMs);

    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function waitForJsonFile(
  filePath: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      return JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${filePath}`);
    }
    await delay(25);
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function waitForCondition(
  description: string,
  condition: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${description}`);
    }
    await delay(25);
  }
}

async function waitForChildExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out waiting for packaged acpx PID ${child.pid} to exit`));
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

test("packaged bin prints version through package executable mapping", async (t) => {
  if (!existsSync(DIST_CLI_PATH)) {
    t.skip("run pnpm build before packaged-bin smoke tests");
    return;
  }

  await withTempHome(async (homeDir) => {
    const result = await runPackageBin(["--version"], homeDir);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr.trim(), "");
    assert.equal(result.stdout.trim(), readPackageVersion());
  });
});

test("packaged bin prints version with top-level output flags", async (t) => {
  if (!existsSync(DIST_CLI_PATH)) {
    t.skip("run pnpm build before packaged-bin smoke tests");
    return;
  }

  await withTempHome(async (homeDir) => {
    const result = await runPackageBin(["--json-strict", "--version"], homeDir);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr.trim(), "");
    assert.equal(result.stdout.trim(), readPackageVersion());
  });
});

test("SEA preserves top-level version and help short-circuits before flow delegation", async (t) => {
  if (!process.env.ACPX_TEST_PACKAGE_BIN) {
    t.skip("set ACPX_TEST_PACKAGE_BIN to a SEA before running this smoke test");
    return;
  }

  await withTempHome(async (homeDir) => {
    const cases = [
      { args: ["--version", "flow"], expected: readPackageVersion() },
      { args: ["-V", "flow"], expected: readPackageVersion() },
      { args: ["--help", "flow"], expected: "Usage: acpx" },
      { args: ["-h", "flow"], expected: "Usage: acpx" },
    ];

    for (const testCase of cases) {
      const result = await runPackageBin(testCase.args, homeDir, 15_000, {
        PATH: homeDir,
      });

      assert.equal(result.code, 0, `${testCase.args.join(" ")}\n${result.stderr}`);
      assert.equal(result.signal, null);
      assert.equal(result.stderr, "");
      assert.match(result.stdout, new RegExp(testCase.expected.replaceAll(".", "\\.")));
      assert.doesNotMatch(result.stdout, /Unable to start SEA flow runtime/);
    }
  });
});

test("SEA build SBOM identifies the embedded esbuild runtime and platform binary", (t) => {
  if (!process.env.ACPX_TEST_PACKAGE_BIN || !existsSync(DIST_SEA_SBOM_PATH)) {
    t.skip("build the SEA and set ACPX_TEST_PACKAGE_BIN before checking its SBOM");
    return;
  }

  const sbom = JSON.parse(readFileSync(DIST_SEA_SBOM_PATH, "utf8")) as {
    components?: Array<{
      group?: unknown;
      name?: unknown;
      version?: unknown;
      "bom-ref"?: unknown;
      hashes?: unknown;
    }>;
    dependencies?: Array<{
      ref?: unknown;
      dependsOn?: unknown;
    }>;
  };
  const components = sbom.components ?? [];
  const esbuild = components.find((component) => component.name === "esbuild");
  assert.ok(esbuild);
  assert.equal(typeof esbuild.version, "string");
  assert.equal(typeof esbuild["bom-ref"], "string");

  const platformPackageName = `${process.platform}-${process.arch}`;
  const platformBinary = components.find(
    (component) =>
      component.group === "@esbuild" &&
      component.name === platformPackageName &&
      component.version === esbuild.version,
  );
  assert.ok(platformBinary);
  assert.equal(typeof platformBinary["bom-ref"], "string");
  assert.ok(Array.isArray(platformBinary.hashes));
  assert.deepEqual(platformBinary.hashes, [
    {
      alg: "SHA-256",
      content: createHash("sha256")
        .update(readFileSync(path.join(process.cwd(), "dist-sea", "runtime", "esbuild")))
        .digest("hex"),
    },
  ]);

  const esbuildDependency = (sbom.dependencies ?? []).find(
    (dependency) => dependency.ref === esbuild["bom-ref"],
  );
  assert.ok(esbuildDependency);
  assert.ok(Array.isArray(esbuildDependency.dependsOn));
  assert.ok(esbuildDependency.dependsOn.includes(platformBinary["bom-ref"]));
});

test("packaged bin runs a mock-agent exec command through package executable mapping", async (t) => {
  if (!existsSync(DIST_CLI_PATH)) {
    t.skip("run pnpm build before packaged-bin smoke tests");
    return;
  }

  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const result = await runPackageBin(
      [
        "--agent",
        MOCK_AGENT_COMMAND,
        "--cwd",
        cwd,
        "--format",
        "quiet",
        "exec",
        "echo packaged-bin-ok",
      ],
      homeDir,
    );

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), "packaged-bin-ok");
  });
});

test("packaged bin runs a TypeScript flow with leading global flags", async (t) => {
  if (!process.env.ACPX_TEST_PACKAGE_BIN && !existsSync(DIST_CLI_PATH)) {
    t.skip("run pnpm build or set ACPX_TEST_PACKAGE_BIN before packaged-bin smoke tests");
    return;
  }

  await withTempHome(async (homeDir) => {
    const flowPath = path.join(homeDir, "standalone.flow.ts");
    await fs.writeFile(
      flowPath,
      [
        'import { compute, defineFlow } from "acpx/flows";',
        'enum Message { Ok = "packaged-flow-ok" }',
        "const message: Message = Message.Ok;",
        "export default defineFlow({",
        '  name: "packaged-flow",',
        '  startAt: "finish",',
        "  nodes: {",
        "    finish: compute({ run: () => ({ message }) }),",
        "  },",
        "  edges: [],",
        "});",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await runPackageBin(["--format", "json", "flow", "run", flowPath], homeDir);

    assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
    assert.equal(result.signal, null);
    assert.match(result.stdout, /packaged-flow-ok/);
  });
});

test("packaged bin runs a CommonJS flow that requires acpx/flows", async (t) => {
  if (!process.env.ACPX_TEST_PACKAGE_BIN && !existsSync(DIST_CLI_PATH)) {
    t.skip("run pnpm build or set ACPX_TEST_PACKAGE_BIN before packaged-bin smoke tests");
    return;
  }

  await withTempHome(async (homeDir) => {
    const flowPath = path.join(homeDir, "standalone.flow.cjs");
    await fs.writeFile(
      flowPath,
      [
        'const { compute, defineFlow } = require("acpx/flows");',
        "module.exports = defineFlow({",
        '  name: "packaged-commonjs-flow",',
        '  startAt: "finish",',
        "  nodes: {",
        '    finish: compute({ run: () => ({ message: "packaged-commonjs-flow-ok" }) }),',
        "  },",
        "  edges: [],",
        "});",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await runPackageBin(["--format", "json", "flow", "run", flowPath], homeDir);

    assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
    assert.equal(result.signal, null);
    assert.match(result.stdout, /packaged-commonjs-flow-ok/);
  });
});

test("SEA flow delegation fails clearly when system Node is unavailable", async (t) => {
  if (!process.env.ACPX_TEST_PACKAGE_BIN) {
    t.skip("set ACPX_TEST_PACKAGE_BIN to a SEA before running this smoke test");
    return;
  }

  await withTempHome(async (homeDir) => {
    const flowPath = path.join(homeDir, "standalone.flow.mjs");
    await fs.writeFile(
      flowPath,
      [
        'import { compute, defineFlow } from "acpx/flows";',
        "export default defineFlow({",
        '  name: "packaged-flow-no-node",',
        '  startAt: "finish",',
        "  nodes: { finish: compute({ run: () => ({ ok: true }) }) },",
        "  edges: [],",
        "});",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await runPackageBin(["flow", "run", flowPath], homeDir, 15_000, {
      PATH: homeDir,
    });

    assert.equal(result.code, 1, result.stderr);
    assert.equal(result.signal, null);
    assert.match(result.stderr, /Unable to start SEA flow runtime/);
    assert.match(result.stderr, /ENOENT/);
  });
});

test("SEA flow delegation forwards termination signals and removes its temp runtime", async (t) => {
  if (!process.env.ACPX_TEST_PACKAGE_BIN) {
    t.skip("set ACPX_TEST_PACKAGE_BIN to a SEA before running this smoke test");
    return;
  }
  if (process.platform === "win32") {
    t.skip("POSIX signal semantics are unavailable on Windows");
    return;
  }

  for (const terminationSignal of ["SIGTERM", "SIGINT"] as const) {
    await t.test(terminationSignal, async () => {
      await withTempHome(async (homeDir) => {
        const markerPath = path.join(homeDir, "delegated-flow.json");
        const flowPath = path.join(homeDir, "blocking.flow.mjs");
        await fs.writeFile(
          flowPath,
          [
            'import fs from "node:fs/promises";',
            'import path from "node:path";',
            'import { compute, defineFlow } from "acpx/flows";',
            `const markerPath = ${JSON.stringify(markerPath)};`,
            "export default defineFlow({",
            '  name: "packaged-signal-flow",',
            '  startAt: "wait",',
            "  nodes: {",
            "    wait: compute({",
            "      run: async () => {",
            "        const runtimePath = process.env.ACPX_FLOW_RUNTIME_PATH;",
            "        const esbuildBinaryPath = process.env.ESBUILD_BINARY_PATH;",
            '        if (!runtimePath) throw new Error("missing SEA flow runtime path");',
            '        if (!esbuildBinaryPath) throw new Error("missing esbuild binary path");',
            "        const tempDir = path.dirname(runtimePath);",
            '        const esbuildPackagePath = path.join(tempDir, "node_modules/esbuild/package.json");',
            '        const esbuildMainPath = path.join(tempDir, "node_modules/esbuild/lib/main.js");',
            "        const [tempStat, binaryStat, packageStat, mainStat] = await Promise.all([",
            "          fs.stat(tempDir),",
            "          fs.stat(esbuildBinaryPath),",
            "          fs.stat(esbuildPackagePath),",
            "          fs.stat(esbuildMainPath),",
            "        ]);",
            "        await fs.writeFile(",
            "          markerPath,",
            "          JSON.stringify({",
            "            pid: process.pid,",
            "            tempDir,",
            "            tempMode: tempStat.mode & 0o777,",
            "            esbuildBinaryPath,",
            "            esbuildBinaryMode: binaryStat.mode & 0o777,",
            "            esbuildPackagePath,",
            "            esbuildPackageMode: packageStat.mode & 0o777,",
            "            esbuildMainPath,",
            "            esbuildMainMode: mainStat.mode & 0o777,",
            "          }),",
            "        );",
            "        await new Promise(() => {});",
            "      },",
            "    }),",
            "  },",
            "  edges: [],",
            "});",
            "",
          ].join("\n"),
          "utf8",
        );

        const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir };
        delete env.NODE_V8_COVERAGE;
        const command = packageBinSpawnArgs(["flow", "run", flowPath]);
        const child = spawn(command.command, command.args, {
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });

        let delegatedPid: number | undefined;
        let delegatedTempDir: string | undefined;
        let stderr = "";
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => {
          stderr += chunk;
        });

        try {
          const marker = await waitForJsonFile(markerPath, 10_000);
          assert.equal(typeof marker.pid, "number");
          assert.equal(typeof marker.tempDir, "string");
          const activeDelegatedPid = marker.pid as number;
          const activeDelegatedTempDir = marker.tempDir as string;
          delegatedPid = activeDelegatedPid;
          delegatedTempDir = activeDelegatedTempDir;
          assert.equal(isProcessAlive(activeDelegatedPid), true);
          assert.equal(existsSync(activeDelegatedTempDir), true);
          assert.equal(marker.tempMode, 0o700);
          assert.equal(marker.esbuildBinaryPath, path.join(activeDelegatedTempDir, "esbuild"));
          assert.equal(marker.esbuildBinaryMode, 0o700);
          assert.equal(
            marker.esbuildPackagePath,
            path.join(activeDelegatedTempDir, "node_modules", "esbuild", "package.json"),
          );
          assert.equal(marker.esbuildPackageMode, 0o600);
          assert.equal(
            marker.esbuildMainPath,
            path.join(activeDelegatedTempDir, "node_modules", "esbuild", "lib", "main.js"),
          );
          assert.equal(marker.esbuildMainMode, 0o600);

          const exitPromise = waitForChildExit(child, 5_000);
          assert.equal(child.kill(terminationSignal), true);
          const parentExit = await exitPromise;
          assert.equal(parentExit.code, null, stderr);
          assert.equal(parentExit.signal, terminationSignal, stderr);

          await waitForCondition(
            `delegated flow PID ${activeDelegatedPid} to terminate`,
            () => !isProcessAlive(activeDelegatedPid),
            5_000,
          );
          await waitForCondition(
            `delegated flow temp dir ${activeDelegatedTempDir} to be removed`,
            () => !existsSync(activeDelegatedTempDir),
            5_000,
          );
        } finally {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
          if (delegatedPid !== undefined && isProcessAlive(delegatedPid)) {
            process.kill(delegatedPid, "SIGKILL");
            await waitForCondition(
              `test-owned delegated flow PID ${delegatedPid} cleanup`,
              () => !isProcessAlive(delegatedPid as number),
              5_000,
            );
          }
          if (
            delegatedTempDir !== undefined &&
            path.dirname(delegatedTempDir) === os.tmpdir() &&
            path.basename(delegatedTempDir).startsWith("acpx-sea-flow-")
          ) {
            await fs.rm(delegatedTempDir, { recursive: true, force: true });
          }
        }
      });
    });
  }
});

test("SEA signal cleanup reaps a detached ACP adapter before the launcher exits", async (t) => {
  if (!process.env.ACPX_TEST_PACKAGE_BIN) {
    t.skip("set ACPX_TEST_PACKAGE_BIN to a SEA before running this smoke test");
    return;
  }
  if (process.platform === "win32") {
    t.skip("POSIX signal semantics are unavailable on Windows");
    return;
  }

  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const adapterPidPath = path.join(homeDir, "adapter.pid");
    const promptActivePath = path.join(homeDir, "prompt-active");
    const blockingTerminalPath = path.join(homeDir, "blocking-terminal.cjs");
    const flowPath = path.join(homeDir, "blocking-adapter.flow.mjs");
    await fs.mkdir(cwd, { recursive: true });
    await fs.writeFile(
      blockingTerminalPath,
      [
        'const fs = require("node:fs");',
        'fs.writeFileSync(process.argv[2], "ready\\n", "utf8");',
        "setInterval(() => {}, 1_000);",
        "",
      ].join("\n"),
      "utf8",
    );
    const terminalPrompt = [
      "terminal",
      JSON.stringify(process.execPath),
      JSON.stringify(blockingTerminalPath),
      JSON.stringify(promptActivePath),
    ].join(" ");
    await fs.writeFile(
      flowPath,
      [
        'import { acp, defineFlow } from "acpx/flows";',
        "export default defineFlow({",
        '  name: "packaged-adapter-signal-flow",',
        '  startAt: "wait",',
        "  nodes: {",
        "    wait: acp({",
        `      prompt: async () => ${JSON.stringify(terminalPrompt)},`,
        "    }),",
        "  },",
        "  edges: [],",
        "});",
        "",
      ].join("\n"),
      "utf8",
    );

    const agentCommand = [
      JSON.stringify(process.execPath),
      JSON.stringify(MOCK_AGENT_PATH),
      "--ignore-sigterm",
      "--cancel-delay-ms",
      "3000",
      "--pid-file",
      JSON.stringify(adapterPidPath),
    ].join(" ");
    const command = packageBinSpawnArgs([
      "--agent",
      agentCommand,
      "--approve-all",
      "--cwd",
      cwd,
      "flow",
      "run",
      flowPath,
    ]);
    const child = spawn(command.command, command.args, {
      env: { ...process.env, HOME: homeDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let adapterPid: number | undefined;
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    try {
      await waitForCondition(
        `blocking ACP prompt marker ${promptActivePath}`,
        () => existsSync(promptActivePath),
        10_000,
      );
      adapterPid = Number((await fs.readFile(adapterPidPath, "utf8")).trim());
      assert.equal(Number.isInteger(adapterPid) && adapterPid > 0, true);
      assert.equal(isProcessAlive(adapterPid), true);

      const exitPromise = waitForChildExit(child, 12_000);
      assert.equal(child.kill("SIGTERM"), true);
      const parentExit = await exitPromise;
      assert.equal(parentExit.code, null, stderr);
      assert.equal(parentExit.signal, "SIGTERM", stderr);
      assert.equal(
        isProcessAlive(adapterPid),
        false,
        `detached ACP adapter PID ${adapterPid} survived SEA signal cleanup`,
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      if (adapterPid !== undefined && isProcessAlive(adapterPid)) {
        process.kill(adapterPid, "SIGKILL");
        await waitForCondition(
          `test-owned adapter PID ${adapterPid} cleanup`,
          () => !isProcessAlive(adapterPid as number),
          5_000,
        );
      }
    }
  });
});

test("packaged bin serializes concurrent cold prompts through one detached queue owner", async (t) => {
  if (!process.env.ACPX_TEST_PACKAGE_BIN && !existsSync(DIST_CLI_PATH)) {
    t.skip("run pnpm build or set ACPX_TEST_PACKAGE_BIN before packaged-bin smoke tests");
    return;
  }

  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const baseArgs = ["--agent", MOCK_AGENT_COMMAND, "--approve-all", "--cwd", cwd, "--ttl", "30"];

    const created = await runPackageBin(
      [...baseArgs, "--format", "json", "sessions", "new"],
      homeDir,
    );
    assert.equal(created.code, 0, created.stderr);
    assert.equal(created.signal, null);
    const createdPayload = JSON.parse(created.stdout.trim()) as {
      acpxRecordId?: unknown;
    };
    assert.equal(typeof createdPayload.acpxRecordId, "string");
    const sessionId = createdPayload.acpxRecordId as string;

    try {
      const coldPromptOutputs = Array.from(
        { length: 4 },
        (_, index) => `packaged-owner-cold-${index + 1}`,
      );
      const coldResults = await Promise.all(
        coldPromptOutputs.map(async (output) => {
          return await runPackageBin(
            [...baseArgs, "--format", "quiet", "prompt", `echo ${output}`],
            homeDir,
          );
        }),
      );
      for (const result of coldResults) {
        assert.equal(result.code, 0, result.stderr);
        assert.equal(result.signal, null);
      }
      assert.deepEqual(
        coldResults.map((result) => result.stdout.trim()).toSorted(),
        coldPromptOutputs.toSorted(),
      );

      const firstLease = JSON.parse(
        await fs.readFile(queuePaths(homeDir, sessionId).lockPath, "utf8"),
      ) as {
        pid?: unknown;
      };
      assert.equal(typeof firstLease.pid, "number");

      const status = await runPackageBin([...baseArgs, "--format", "json", "status"], homeDir);
      assert.equal(status.code, 0, status.stderr);
      const statusPayload = JSON.parse(status.stdout.trim()) as {
        status?: unknown;
      };
      assert.equal(statusPayload.status, "alive");

      const warm = await runPackageBin(
        [...baseArgs, "--format", "quiet", "prompt", "echo packaged-owner-warm"],
        homeDir,
      );
      assert.equal(warm.code, 0, warm.stderr);
      assert.equal(warm.signal, null);
      assert.equal(warm.stdout.trim(), "packaged-owner-warm");

      const secondLease = JSON.parse(
        await fs.readFile(queuePaths(homeDir, sessionId).lockPath, "utf8"),
      ) as {
        pid?: unknown;
      };
      assert.equal(secondLease.pid, firstLease.pid);
    } finally {
      const closed = await runPackageBin(
        [...baseArgs, "--format", "json", "sessions", "close"],
        homeDir,
      );
      assert.equal(closed.code, 0, closed.stderr);
    }
  });
});
