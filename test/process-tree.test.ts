import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  captureProcessTreePids,
  createManagedProcessTree,
  resolveProcessTreeSignalTargets,
  signalProcessTree,
  waitForProcessTreeExit,
} from "../src/acp/process-tree.js";

const execFileAsync = promisify(execFile);

test("running POSIX trees signal the owned process group", () => {
  const tree = createManagedProcessTree(4100, true, "darwin");
  tree.descendantPids.add(4101);

  assert.deepEqual(resolveProcessTreeSignalTargets(tree, true), [{ pid: -4100, tree: false }]);
});

test("exited POSIX roots never signal a potentially recycled process group", () => {
  const tree = createManagedProcessTree(4200, true, "linux");
  tree.descendantPids.add(4201);
  tree.descendantPids.add(4202);

  assert.deepEqual(resolveProcessTreeSignalTargets(tree, false), [
    { pid: 4201, tree: false },
    { pid: 4202, tree: false },
  ]);
});

test("Windows uses taskkill trees for a running root and remembered descendants after exit", () => {
  const tree = createManagedProcessTree(4300, true, "win32");
  tree.descendantPids.add(4301);
  tree.descendantPids.add(4302);

  assert.deepEqual(resolveProcessTreeSignalTargets(tree, true), [{ pid: 4300, tree: true }]);
  assert.deepEqual(resolveProcessTreeSignalTargets(tree, false), [
    { pid: 4301, tree: true },
    { pid: 4302, tree: true },
  ]);
});

test("non-group processes signal only their root", () => {
  const tree = createManagedProcessTree(4400, false, "linux");
  tree.descendantPids.add(4401);

  assert.deepEqual(resolveProcessTreeSignalTargets(tree, true), [{ pid: 4400, tree: false }]);
});

test("waitForProcessTreeExit waits for the exit-triggered process snapshot", async () => {
  const tree = createManagedProcessTree(4500, true, "linux");
  let resolveSnapshot: (() => void) | undefined;
  tree.snapshotPromise = new Promise<void>((resolve) => {
    resolveSnapshot = resolve;
  });

  const exitResult = waitForProcessTreeExit(tree, () => false, 50);
  tree.descendantPids.add(process.pid);
  resolveSnapshot?.();

  assert.equal(await exitResult, false);
});

test("waitForProcessTreeExit keeps a live non-group root in the cleanup loop", async () => {
  const tree = createManagedProcessTree(process.pid, false, process.platform);

  assert.equal(await waitForProcessTreeExit(tree, () => true, 10), false);
});

test(
  "process-tree snapshots bound stalled process-list commands",
  { skip: process.platform === "win32" },
  async () => {
    const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-stalled-ps-"));
    const psPath = path.join(fixtureDir, "ps");
    const originalPath = process.env.PATH;
    await fs.writeFile(psPath, "#!/bin/sh\nwhile :; do :; done\n", { mode: 0o755 });
    process.env.PATH = `${fixtureDir}${path.delimiter}${originalPath ?? ""}`;

    try {
      const tree = createManagedProcessTree(process.pid, true, "linux");
      const startedAt = Date.now();
      await captureProcessTreePids(tree, true);
      assert(Date.now() - startedAt < 3_000);
    } finally {
      process.env.PATH = originalPath;
      await fs.rm(fixtureDir, { recursive: true, force: true });
    }
  },
);

test(
  "signaling a running POSIX group does not wait for another process-list snapshot",
  { skip: process.platform === "win32" },
  async () => {
    const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-stalled-ps-signal-"));
    const psPath = path.join(fixtureDir, "ps");
    const originalPath = process.env.PATH;
    await fs.writeFile(psPath, "#!/bin/sh\nwhile :; do :; done\n", { mode: 0o755 });
    process.env.PATH = `${fixtureDir}${path.delimiter}${originalPath ?? ""}`;

    try {
      const tree = createManagedProcessTree(process.pid, true, process.platform);
      const startedAt = Date.now();
      await signalProcessTree(tree, true, "SIGCONT");
      assert(Date.now() - startedAt < 500);
    } finally {
      process.env.PATH = originalPath;
      await fs.rm(fixtureDir, { recursive: true, force: true });
    }
  },
);

test(
  "exited POSIX trees discard remembered PIDs whose identity changed",
  { skip: process.platform === "win32" },
  async () => {
    const { stdout } = await execFileAsync("ps", ["-o", "pgid=", "-p", String(process.pid)]);
    const processGroupId = Number(stdout.trim());
    assert(Number.isInteger(processGroupId));

    const tree = createManagedProcessTree(processGroupId, true, process.platform);
    tree.descendantPids.add(process.pid);
    tree.descendantIdentities.set(process.pid, "not-this-process");

    await signalProcessTree(tree, false, "SIGCONT");

    assert.equal(tree.descendantPids.has(process.pid), false);
    assert.equal(tree.descendantIdentities.has(process.pid), false);
  },
);

test(
  "exited POSIX trees discover descendants spawned after the exit snapshot",
  { skip: process.platform === "win32" },
  async () => {
    const child = spawn(
      "sh",
      ["-c", "trap 'sleep 30 & exit 0' TERM; echo ready; while :; do sleep 1; done"],
      {
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const rootPid = child.pid;
    assert(rootPid);

    try {
      await once(child.stdout, "data");
      const tree = createManagedProcessTree(rootPid, true, process.platform);
      await captureProcessTreePids(tree, true);
      await signalProcessTree(tree, true, "SIGTERM");
      if (child.exitCode === null && child.signalCode === null) {
        await once(child, "exit");
      }

      assert.equal(await waitForProcessTreeExit(tree, () => false, 100), false);

      await signalProcessTree(tree, false, "SIGKILL");
      assert.equal(await waitForProcessTreeExit(tree, () => false, 2_000), true);
    } finally {
      try {
        process.kill(-rootPid, "SIGKILL");
      } catch {
        // The process group was already cleaned up.
      }
      child.stdout.destroy();
    }
  },
);
