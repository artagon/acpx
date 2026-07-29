import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  captureProcessTreePids,
  createManagedProcessTree,
  resolveProcessTreeSignalTargets,
  waitForProcessTreeExit,
} from "../src/acp/process-tree.js";

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
