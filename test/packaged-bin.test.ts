import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { queuePaths } from "./queue-test-helpers.js";

const DIST_CLI_PATH = path.join(process.cwd(), "dist", "cli.js");
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
): Promise<CliRunResult> {
  return await new Promise<CliRunResult>((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: homeDir,
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
      const [first, concurrent] = await Promise.all([
        runPackageBin(
          [...baseArgs, "--format", "quiet", "prompt", "echo packaged-owner-first"],
          homeDir,
        ),
        runPackageBin(
          [...baseArgs, "--format", "quiet", "prompt", "echo packaged-owner-concurrent"],
          homeDir,
        ),
      ]);
      assert.equal(first.code, 0, first.stderr);
      assert.equal(first.signal, null);
      assert.equal(first.stdout.trim(), "packaged-owner-first");
      assert.equal(concurrent.code, 0, concurrent.stderr);
      assert.equal(concurrent.signal, null);
      assert.equal(concurrent.stdout.trim(), "packaged-owner-concurrent");

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
