import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLEANUP_FAILURE_FIXTURE = fileURLToPath(
  new URL("./fixtures/sea-flow-cleanup-failure.js", import.meta.url),
);

type FixtureProcess = {
  child: ChildProcess;
  exited: Promise<{ code: number | null; signal: string | null }>;
  stderr: () => string;
  stdout: () => string;
};

function startFixture(mode: "operation-error" | "signal" | "success"): FixtureProcess {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_V8_COVERAGE;
  const child = spawn(process.execPath, [CLEANUP_FAILURE_FIXTURE, mode], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out waiting for cleanup fixture PID ${child.pid}`));
    }, 5_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });

  return {
    child,
    exited,
    stderr: () => stderr,
    stdout: () => stdout,
  };
}

async function waitForReadyPid(fixture: FixtureProcess): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (true) {
    const match = /^READY (\d+)$/m.exec(fixture.stdout());
    if (match) {
      return Number(match[1]);
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for delegated child PID: ${fixture.stderr()}`);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
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

test("SEA flow delegation surfaces cleanup failure after a successful child", async () => {
  const fixture = startFixture("success");

  const result = await fixture.exited;

  assert.equal(result.code, 1);
  assert.equal(result.signal, null);
  assert.equal(fixture.stderr(), "injected cleanup failure\n");
});

test("SEA flow delegation preserves the operation failure when cleanup also fails", async () => {
  const fixture = startFixture("operation-error");

  const result = await fixture.exited;

  assert.equal(result.code, 1);
  assert.equal(result.signal, null);
  assert.equal(fixture.stderr(), "injected operation failure\n");
});

test("SEA flow delegation preserves forwarded signals when cleanup fails", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX signal semantics are unavailable on Windows");
    return;
  }

  for (const terminationSignal of ["SIGTERM", "SIGINT"] as const) {
    await t.test(terminationSignal, async () => {
      const fixture = startFixture("signal");
      let delegatedPid: number | undefined;

      try {
        delegatedPid = await waitForReadyPid(fixture);
        assert.equal(fixture.child.kill(terminationSignal), true);
        const result = await fixture.exited;
        assert.equal(result.code, null, fixture.stderr());
        assert.equal(result.signal, terminationSignal, fixture.stderr());
      } finally {
        if (fixture.child.exitCode === null && fixture.child.signalCode === null) {
          fixture.child.kill("SIGKILL");
        }
        if (delegatedPid !== undefined && isProcessAlive(delegatedPid)) {
          process.kill(delegatedPid, "SIGKILL");
        }
      }
    });
  }
});
