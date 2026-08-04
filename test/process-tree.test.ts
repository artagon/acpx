import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  beginProcessTreeTracking,
  captureProcessTreePids,
  collectWindowsDescendantProcesses,
  createManagedProcessTree,
  isProcessTreeEnumerationHealthy,
  readProcessIdentity,
  resolveProcessTreeSignalTargets,
  signalProcessTree,
  waitForProcessTreeExit,
} from "../src/acp/process-tree.js";

const execFileAsync = promisify(execFile);

test("Windows descendant tracking validates creation order and terminates cycles", () => {
  const processList = [
    { pid: 100, parentPid: 102, identity: "1000" },
    { pid: 101, parentPid: 100, identity: "1100" },
    { pid: 102, parentPid: 101, identity: "1200" },
    { pid: 103, parentPid: 100, identity: "900" },
  ];

  assert.deepEqual(collectWindowsDescendantProcesses(100, "1000", processList), {
    rootIdentity: "1000",
    descendants: [processList[1], processList[2]],
  });
  assert.equal(collectWindowsDescendantProcesses(100, "different-root", processList), undefined);

  const afterRootExit = processList.slice(1);
  assert.equal(collectWindowsDescendantProcesses(100, undefined, afterRootExit, "1000"), undefined);
});

test(
  "continuous Windows tracking captures children spawned after the initial snapshot",
  { skip: process.platform === "win32" },
  async () => {
    const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-windows-tracking-"));
    const powershellPath = path.join(fixtureDir, "powershell.exe");
    const counterPath = path.join(fixtureDir, "counter");
    const originalPath = process.env.PATH;
    await fs.writeFile(
      powershellPath,
      [
        "#!/bin/sh",
        `counter=${JSON.stringify(counterPath)}`,
        'count=$(cat "$counter" 2>/dev/null || true)',
        "count=${count:-0}",
        "count=$((count + 1))",
        'printf "%s" "$count" > "$counter"',
        'printf "500 1 1000\\n"',
        'if [ "$count" -ge 2 ]; then',
        '  printf "600 500 1100\\n"',
        "fi",
        'if [ "$count" -ge 3 ]; then',
        `  printf "${process.pid} 600 1200\\n"`,
        "fi",
      ].join("\n"),
      { mode: 0o755 },
    );
    process.env.PATH = `${fixtureDir}${path.delimiter}${originalPath ?? ""}`;

    let running = true;
    try {
      const tree = createManagedProcessTree(500, true, "win32");
      beginProcessTreeTracking(tree, () => running);
      for (let attempt = 0; attempt < 100 && !tree.descendantPids.has(process.pid); attempt += 1) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 25);
        });
      }
      running = false;
      await tree.snapshotPromise;
      const completedSamples = await fs.readFile(counterPath, "utf8");
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });
      assert.equal(await fs.readFile(counterPath, "utf8"), completedSamples);
      await captureProcessTreePids(tree, false);
      assert.equal(tree.descendantPids.has(process.pid), true);
    } finally {
      running = false;
      process.env.PATH = originalPath;
      await fs.rm(fixtureDir, { recursive: true, force: true });
    }
  },
);

test(
  "bounded POSIX tracking survives observer failures and captures children before root exit",
  { skip: process.platform === "win32" },
  async () => {
    const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-posix-tracking-"));
    const psPath = path.join(fixtureDir, "ps");
    const counterPath = path.join(fixtureDir, "counter");
    const originalPath = process.env.PATH;
    await fs.writeFile(
      psPath,
      [
        "#!/bin/sh",
        `counter=${JSON.stringify(counterPath)}`,
        'count=$(cat "$counter" 2>/dev/null || true)',
        "count=${count:-0}",
        "count=$((count + 1))",
        'printf "%s" "$count" > "$counter"',
        'printf "500 1 500 Wed Jul 29 12:00:00 2026\\n"',
        'if [ "$count" -ge 2 ]; then',
        `  printf "${process.pid} 500 999 Wed Jul 29 12:00:01 2026\\n"`,
        "fi",
      ].join("\n"),
      { mode: 0o755 },
    );
    process.env.PATH = `${fixtureDir}${path.delimiter}${originalPath ?? ""}`;

    let running = true;
    try {
      const tree = createManagedProcessTree(500, true, "darwin");
      let observations = 0;
      beginProcessTreeTracking(
        tree,
        () => running,
        () => {
          observations += 1;
          throw new Error("observer failure");
        },
      );
      for (let attempt = 0; attempt < 100 && !tree.descendantPids.has(process.pid); attempt += 1) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 25);
        });
      }
      running = false;
      await tree.snapshotPromise;

      assert.equal(tree.descendantPids.has(process.pid), true);
      assert.ok(observations >= 2);
      assert.equal(await isProcessTreeEnumerationHealthy(tree), true);
    } finally {
      running = false;
      process.env.PATH = originalPath;
      await fs.rm(fixtureDir, { recursive: true, force: true });
    }
  },
);

test(
  "Linux process identities do not depend on unsupported BusyBox ps columns",
  { skip: process.platform !== "linux" },
  async () => {
    const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-busybox-ps-"));
    const psPath = path.join(fixtureDir, "ps");
    const originalPath = process.env.PATH;
    await fs.writeFile(psPath, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    process.env.PATH = `${fixtureDir}${path.delimiter}${originalPath ?? ""}`;

    try {
      assert.match((await readProcessIdentity(process.pid, "linux")) ?? "", /^\d+$/);
    } finally {
      process.env.PATH = originalPath;
      await fs.rm(fixtureDir, { recursive: true, force: true });
    }
  },
);

test(
  "non-Linux POSIX snapshots force a locale-independent process identity",
  { skip: process.platform === "win32" },
  async () => {
    const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-posix-locale-"));
    const psPath = path.join(fixtureDir, "ps");
    const originalPath = process.env.PATH;
    await fs.writeFile(
      psPath,
      [
        "#!/bin/sh",
        'test "$LC_ALL" = C || exit 9',
        'printf "500 1 500 Wed Jul 29 12:00:00 2026\\n"',
        `printf "${process.pid} 500 999 Wed Jul 29 12:00:01 2026\\n"`,
      ].join("\n"),
      { mode: 0o755 },
    );
    process.env.PATH = `${fixtureDir}${path.delimiter}${originalPath ?? ""}`;

    try {
      const tree = createManagedProcessTree(500, true, "darwin");
      await captureProcessTreePids(tree, true);
      assert.equal(tree.descendantPids.has(process.pid), true);
    } finally {
      process.env.PATH = originalPath;
      await fs.rm(fixtureDir, { recursive: true, force: true });
    }
  },
);

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
      const tree = createManagedProcessTree(process.pid, true, "darwin");
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
  "successful process enumeration records healthy snapshot state",
  { skip: process.platform === "win32" },
  async () => {
    const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-healthy-ps-"));
    const psPath = path.join(fixtureDir, "ps");
    const originalPath = process.env.PATH;
    await fs.writeFile(psPath, "#!/bin/sh\nprintf '500 1 500 Wed Jul 29 12:00:00 2026\\n'\n", {
      mode: 0o755,
    });
    process.env.PATH = `${fixtureDir}${path.delimiter}${originalPath ?? ""}`;

    try {
      const tree = createManagedProcessTree(500, true, "darwin");
      await captureProcessTreePids(tree, true);

      assert.equal(Reflect.get(tree, "enumerationHealthy"), true);
    } finally {
      process.env.PATH = originalPath;
      await fs.rm(fixtureDir, { recursive: true, force: true });
    }
  },
);

test(
  "successful enumeration remains healthy when the root exits before the snapshot",
  { skip: process.platform === "win32" },
  async () => {
    const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-exited-before-snapshot-"));
    const psPath = path.join(fixtureDir, "ps");
    const originalPath = process.env.PATH;
    await fs.writeFile(psPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    process.env.PATH = `${fixtureDir}${path.delimiter}${originalPath ?? ""}`;

    try {
      const tree = createManagedProcessTree(500, true, "darwin");
      await captureProcessTreePids(tree, true);

      assert.equal(await isProcessTreeEnumerationHealthy(tree), true);
    } finally {
      process.env.PATH = originalPath;
      await fs.rm(fixtureDir, { recursive: true, force: true });
    }
  },
);

test(
  "tracking retains descendants observed by an in-flight snapshot after the root exits",
  { skip: process.platform === "win32" },
  async () => {
    const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-in-flight-ps-"));
    const psPath = path.join(fixtureDir, "ps");
    const originalPath = process.env.PATH;
    await fs.writeFile(psPath, "#!/bin/sh\nprintf '500 1 500 Wed Jul 29 12:00:00 2026\\n'\n", {
      mode: 0o755,
    });
    process.env.PATH = `${fixtureDir}${path.delimiter}${originalPath ?? ""}`;

    try {
      const tree = createManagedProcessTree(500, true, "darwin");
      await captureProcessTreePids(tree, true);

      await fs.writeFile(
        psPath,
        "#!/bin/sh\nsleep 0.1\nprintf '500 1 500 Wed Jul 29 12:00:00 2026\\n501 500 500 Wed Jul 29 12:00:01 2026\\n'\n",
        { mode: 0o755 },
      );
      let rootRunning = true;
      beginProcessTreeTracking(tree, () => rootRunning);
      await new Promise((resolve) => setTimeout(resolve, 20));
      rootRunning = false;

      assert.equal(await isProcessTreeEnumerationHealthy(tree), true);
      assert.equal(tree.descendantPids.has(501), true);
      assert.equal(tree.descendantIdentities.has(501), true);
    } finally {
      process.env.PATH = originalPath;
      await fs.rm(fixtureDir, { recursive: true, force: true });
    }
  },
);

test(
  "tracking rejects a late first snapshot after the root identity is lost",
  { skip: process.platform === "win32" },
  async () => {
    const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-unanchored-ps-"));
    const psPath = path.join(fixtureDir, "ps");
    const originalPath = process.env.PATH;
    await fs.writeFile(
      psPath,
      "#!/bin/sh\nsleep 0.1\nprintf '500 1 500 Wed Jul 29 12:00:00 2026\\n501 500 500 Wed Jul 29 12:00:01 2026\\n'\n",
      { mode: 0o755 },
    );
    process.env.PATH = `${fixtureDir}${path.delimiter}${originalPath ?? ""}`;

    try {
      let rootRunning = true;
      const tree = createManagedProcessTree(500, true, "darwin");
      beginProcessTreeTracking(tree, () => rootRunning);
      await new Promise((resolve) => setTimeout(resolve, 20));
      rootRunning = false;

      assert.equal(await isProcessTreeEnumerationHealthy(tree), true);
      assert.equal(tree.descendantPids.has(501), false);
      assert.equal(tree.descendantIdentities.has(501), false);
    } finally {
      process.env.PATH = originalPath;
      await fs.rm(fixtureDir, { recursive: true, force: true });
    }
  },
);

test(
  "process enumeration failure remains unhealthy after a later successful snapshot",
  { skip: process.platform === "win32" },
  async () => {
    const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-failed-ps-"));
    const psPath = path.join(fixtureDir, "ps");
    const counterPath = path.join(fixtureDir, "counter");
    const originalPath = process.env.PATH;
    await fs.writeFile(
      psPath,
      [
        "#!/bin/sh",
        `counter=${JSON.stringify(counterPath)}`,
        'if [ ! -e "$counter" ]; then',
        '  printf failed > "$counter"',
        "  exit 1",
        "fi",
        'printf "500 1 500 Wed Jul 29 12:00:00 2026\\n"',
      ].join("\n"),
      { mode: 0o755 },
    );
    process.env.PATH = `${fixtureDir}${path.delimiter}${originalPath ?? ""}`;

    try {
      const tree = createManagedProcessTree(500, true, "darwin");
      await captureProcessTreePids(tree, true);
      await captureProcessTreePids(tree, true);

      assert.equal(Reflect.get(tree, "enumerationHealthy"), false);
    } finally {
      process.env.PATH = originalPath;
      await fs.rm(fixtureDir, { recursive: true, force: true });
    }
  },
);

test(
  "transient Windows process-list failures preserve remembered descendants",
  { skip: process.platform === "win32" },
  async () => {
    const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-stalled-powershell-"));
    const powershellPath = path.join(fixtureDir, "powershell.exe");
    const originalPath = process.env.PATH;
    await fs.writeFile(powershellPath, "#!/bin/sh\nwhile :; do :; done\n", { mode: 0o755 });
    process.env.PATH = `${fixtureDir}${path.delimiter}${originalPath ?? ""}`;

    try {
      const tree = createManagedProcessTree(999_999, true, "win32");
      tree.descendantPids.add(process.pid);
      tree.descendantIdentities.set(process.pid, "remembered");

      await signalProcessTree(tree, false, "SIGCONT");

      assert.equal(tree.descendantPids.has(process.pid), true);
      assert.equal(tree.descendantIdentities.get(process.pid), "remembered");
    } finally {
      process.env.PATH = originalPath;
      await fs.rm(fixtureDir, { recursive: true, force: true });
    }
  },
);

test(
  "Windows snapshots tolerate process-list startup beyond one second",
  { skip: process.platform === "win32" },
  async () => {
    const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-slow-powershell-"));
    const powershellPath = path.join(fixtureDir, "powershell.exe");
    const originalPath = process.env.PATH;
    await fs.writeFile(
      powershellPath,
      [
        "#!/bin/sh",
        "sleep 1.2",
        'printf "500 1 1000\\n"',
        `printf "${process.pid} 500 1100\\n"`,
      ].join("\n"),
      { mode: 0o755 },
    );
    process.env.PATH = `${fixtureDir}${path.delimiter}${originalPath ?? ""}`;

    try {
      const tree = createManagedProcessTree(500, true, "win32");
      await captureProcessTreePids(tree, true);
      assert.equal(tree.descendantPids.has(process.pid), true);
    } finally {
      process.env.PATH = originalPath;
      await fs.rm(fixtureDir, { recursive: true, force: true });
    }
  },
);

test(
  "signaling a running POSIX group bounds its pre-signal descendant snapshot",
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
      assert(Date.now() - startedAt < 1_500);
    } finally {
      process.env.PATH = originalPath;
      await fs.rm(fixtureDir, { recursive: true, force: true });
    }
  },
);

test("process tracking discards a root identity captured after the child exits", async () => {
  const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-exited-root-identity-"));
  const powershellPath = path.join(fixtureDir, "powershell.exe");
  const originalPath = process.env.PATH;
  await fs.writeFile(
    powershellPath,
    [
      "#!/bin/sh",
      "sleep 0.1",
      'printf "500 1 1000\\n"',
      `printf "${process.pid} 500 1100\\n"`,
    ].join("\n"),
    { mode: 0o755 },
  );
  process.env.PATH = `${fixtureDir}${path.delimiter}${originalPath ?? ""}`;

  try {
    let rootRunning = true;
    const tree = createManagedProcessTree(500, true, "win32", 0);
    beginProcessTreeTracking(tree, () => rootRunning);
    setTimeout(() => {
      rootRunning = false;
    }, 20);

    await tree.snapshotPromise;

    assert.equal(tree.rootIdentity, undefined);
    assert.equal(tree.descendantPids.size, 0);
  } finally {
    process.env.PATH = originalPath;
    await fs.rm(fixtureDir, { recursive: true, force: true });
  }
});

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
  "exited POSIX trees preserve identity-validated descendants after group leader PID reuse",
  { skip: process.platform === "win32" },
  async () => {
    const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-posix-reused-leader-"));
    const psPath = path.join(fixtureDir, "ps");
    const originalPath = process.env.PATH;
    const descendantIdentity = "Wed Jul 29 12:00:01 2026";
    await fs.writeFile(
      psPath,
      [
        "#!/bin/sh",
        'printf "500 1 500 Wed Jul 29 12:01:00 2026\\n"',
        `printf "${process.pid} 1 500 ${descendantIdentity}\\n"`,
      ].join("\n"),
      { mode: 0o755 },
    );
    process.env.PATH = `${fixtureDir}${path.delimiter}${originalPath ?? ""}`;

    try {
      const tree = createManagedProcessTree(500, true, "darwin");
      tree.descendantPids.add(process.pid);
      tree.descendantIdentities.set(process.pid, descendantIdentity);

      await signalProcessTree(tree, false, "SIGCONT");

      assert.equal(tree.descendantPids.has(process.pid), true);
      assert.equal(tree.descendantIdentities.get(process.pid), descendantIdentity);
    } finally {
      process.env.PATH = originalPath;
      await fs.rm(fixtureDir, { recursive: true, force: true });
    }
  },
);

test(
  "running POSIX snapshots reject a recycled group with a mismatched root identity",
  { skip: process.platform === "win32" },
  async () => {
    const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-posix-recycled-group-"));
    const psPath = path.join(fixtureDir, "ps");
    const originalPath = process.env.PATH;
    await fs.writeFile(
      psPath,
      [
        "#!/bin/sh",
        'printf "500 1 500 Wed Jul 29 12:01:00 2026\\n"',
        `printf "${process.pid} 500 500 Wed Jul 29 12:01:01 2026\\n"`,
      ].join("\n"),
      { mode: 0o755 },
    );
    process.env.PATH = `${fixtureDir}${path.delimiter}${originalPath ?? ""}`;

    try {
      const tree = createManagedProcessTree(500, true, "darwin");
      tree.rootIdentity = "Wed Jul 29 12:00:00 2026";

      await captureProcessTreePids(tree, true);

      assert.equal(tree.descendantPids.has(process.pid), false);
    } finally {
      process.env.PATH = originalPath;
      await fs.rm(fixtureDir, { recursive: true, force: true });
    }
  },
);

test(
  "exited POSIX trees discover children of identity-validated escaped descendants",
  { skip: process.platform === "win32" },
  async () => {
    const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-posix-escaped-"));
    const psPath = path.join(fixtureDir, "ps");
    const originalPath = process.env.PATH;
    await fs.writeFile(
      psPath,
      [
        "#!/bin/sh",
        'printf "600 1 700 Wed Jul 29 12:00:00 2026\\n"',
        `printf "${process.pid} 600 999 Wed Jul 29 12:00:01 2026\\n"`,
      ].join("\n"),
      { mode: 0o755 },
    );
    process.env.PATH = `${fixtureDir}${path.delimiter}${originalPath ?? ""}`;

    try {
      const tree = createManagedProcessTree(500, true, "darwin");
      tree.descendantPids.add(600);
      tree.descendantIdentities.set(600, "Wed Jul 29 12:00:00 2026");

      await signalProcessTree(tree, false, "SIGCONT");

      assert.equal(tree.descendantPids.has(process.pid), true);
      assert.equal(tree.descendantIdentities.get(process.pid), "Wed Jul 29 12:00:01 2026");
    } finally {
      process.env.PATH = originalPath;
      await fs.rm(fixtureDir, { recursive: true, force: true });
    }
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

test(
  "final POSIX cleanup signals descendants discovered after the prior SIGKILL snapshot",
  { skip: process.platform === "win32" },
  async () => {
    const child = spawn("sh", ["-c", "sleep 30 & echo $!"], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const rootPid = child.pid;
    assert(rootPid);

    try {
      const [output] = await once(child.stdout, "data");
      const descendantPid = Number(String(output).trim());
      assert(Number.isInteger(descendantPid));
      if (child.exitCode === null && child.signalCode === null) {
        await once(child, "exit");
      }

      const tree = createManagedProcessTree(rootPid, true, process.platform);
      assert.equal(await waitForProcessTreeExit(tree, () => false, 2_000, "SIGKILL"), true);
      assert.throws(() => process.kill(descendantPid, 0));
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

test(
  "final POSIX cleanup signals already-tracked live descendants after root exit",
  { skip: process.platform === "win32" },
  async () => {
    const child = spawn("sleep", ["30"], {
      detached: true,
      stdio: "ignore",
    });
    const childPid = child.pid;
    assert(childPid);

    try {
      const childIdentity = await readProcessIdentity(childPid);
      assert(childIdentity);
      const tree = createManagedProcessTree(999_999, true, process.platform);
      tree.descendantPids.add(childPid);
      tree.descendantIdentities.set(childPid, childIdentity);

      assert.equal(await waitForProcessTreeExit(tree, () => false, 2_000, "SIGKILL"), true);
      assert.throws(() => process.kill(childPid, 0));
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
  },
);
