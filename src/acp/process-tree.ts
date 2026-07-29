import { spawn } from "node:child_process";

const PROCESS_TREE_POLL_MS = 25;
const PROCESS_LIST_COMMAND_TIMEOUT_MS = 1_000;

export type ManagedProcessTree = {
  rootPid: number | undefined;
  killProcessGroup: boolean;
  platform: NodeJS.Platform;
  descendantPids: Set<number>;
  snapshotPromise?: Promise<void>;
};

export function createManagedProcessTree(
  rootPid: number | undefined,
  killProcessGroup: boolean,
  platform: NodeJS.Platform = process.platform,
): ManagedProcessTree {
  return {
    rootPid,
    killProcessGroup,
    platform,
    descendantPids: new Set(),
  };
}

export function rememberProcessTreePids(tree: ManagedProcessTree): void {
  queueProcessTreeSnapshot(tree);
}

export function beginProcessTreeTracking(tree: ManagedProcessTree): void {
  if (tree.platform === "win32") {
    queueProcessTreeSnapshot(tree);
  }
}

export async function captureProcessTreePids(
  tree: ManagedProcessTree,
  rootRunning: boolean,
): Promise<void> {
  const rootPid = tree.rootPid;
  if (!tree.killProcessGroup || !rootPid) {
    return;
  }

  if (!rootRunning) {
    await waitForPriorSnapshot(tree);
    return;
  }

  await recordCurrentProcessTreePids(tree);
}

async function waitForPriorSnapshot(tree: ManagedProcessTree): Promise<void> {
  await tree.snapshotPromise?.catch(() => {
    // Process tree snapshots are best-effort because the root may already be gone.
  });
}

function queueProcessTreeSnapshot(tree: ManagedProcessTree): void {
  const priorSnapshot = tree.snapshotPromise;
  tree.snapshotPromise = (async () => {
    await priorSnapshot?.catch(() => {
      // A later snapshot can still succeed after an earlier best-effort failure.
    });
    await recordCurrentProcessTreePids(tree);
  })();
}

async function recordCurrentProcessTreePids(tree: ManagedProcessTree): Promise<void> {
  const rootPid = tree.rootPid;
  if (!tree.killProcessGroup || !rootPid) {
    return;
  }
  const pids =
    tree.platform === "win32"
      ? await listDescendantPids(rootPid, tree.platform)
      : await listProcessGroupPids(rootPid);
  recordProcessTreePids(tree, pids);
}

function recordProcessTreePids(tree: ManagedProcessTree, pids: number[]): void {
  for (const pid of pids) {
    if (pid === tree.rootPid) {
      continue;
    }
    tree.descendantPids.add(pid);
  }
}

export async function signalProcessTree(
  tree: ManagedProcessTree,
  rootRunning: boolean,
  signal: NodeJS.Signals,
): Promise<void> {
  const rootPid = tree.rootPid;
  if (!tree.killProcessGroup || !rootPid) {
    if (rootPid) {
      sendSignal(rootPid, signal);
    }
    return;
  }

  await captureProcessTreePids(tree, rootRunning);
  for (const target of resolveProcessTreeSignalTargets(tree, rootRunning)) {
    if (target.tree) {
      await killWindowsProcessTree(target.pid, signal);
    } else {
      sendSignal(target.pid, signal);
    }
  }
}

export type ProcessTreeSignalTarget = {
  pid: number;
  tree: boolean;
};

export function resolveProcessTreeSignalTargets(
  tree: ManagedProcessTree,
  rootRunning: boolean,
): ProcessTreeSignalTarget[] {
  const rootPid = tree.rootPid;
  if (!rootPid) {
    return [];
  }
  if (!tree.killProcessGroup) {
    return [{ pid: rootPid, tree: false }];
  }
  if (tree.platform === "win32") {
    return rootRunning
      ? [{ pid: rootPid, tree: true }]
      : Array.from(tree.descendantPids, (pid) => ({ pid, tree: true }));
  }
  if (rootRunning) {
    return [{ pid: -rootPid, tree: false }];
  }
  // Once the root exits, its numeric PID/PGID can be recycled. Signal only
  // members captured while the owned group still existed.
  return Array.from(tree.descendantPids, (pid) => ({ pid, tree: false }));
}

export async function waitForProcessTreeExit(
  tree: ManagedProcessTree,
  rootRunning: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (true) {
    let rootIsRunning = rootRunning();
    if (!rootIsRunning) {
      const snapshotCompleted = await waitForPriorSnapshotBeforeDeadline(tree, deadline);
      if (!snapshotCompleted) {
        return false;
      }
      rootIsRunning = rootRunning();
    }
    if (!rootIsRunning && !hasLiveManagedProcessTree(tree, rootIsRunning)) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await waitMs(Math.min(PROCESS_TREE_POLL_MS, Math.max(0, deadline - Date.now())));
  }
}

async function waitForPriorSnapshotBeforeDeadline(
  tree: ManagedProcessTree,
  deadline: number,
): Promise<boolean> {
  const snapshot = tree.snapshotPromise;
  if (!snapshot) {
    return true;
  }
  const remainingMs = Math.max(0, deadline - Date.now());
  return await Promise.race([
    snapshot.then(
      () => true,
      () => true,
    ),
    waitMs(remainingMs).then(() => false),
  ]);
}

function hasLiveManagedProcessTree(tree: ManagedProcessTree, rootRunning: boolean): boolean {
  const rootPid = tree.rootPid;
  if (
    rootRunning &&
    tree.killProcessGroup &&
    rootPid &&
    tree.platform !== "win32" &&
    hasLiveProcessGroup(rootPid)
  ) {
    return true;
  }
  return hasLivePid(tree.descendantPids);
}

async function listDescendantPids(
  rootPid: number,
  platform: NodeJS.Platform = process.platform,
): Promise<number[]> {
  let output: string;
  try {
    output = await runProcessListCommand(platform);
  } catch {
    return [];
  }

  const childrenByParent = new Map<number, number[]>();
  for (const line of output.split("\n")) {
    addProcessListLine(childrenByParent, line);
  }

  const descendants: number[] = [];
  const queue = [...(childrenByParent.get(rootPid) ?? [])];
  for (let index = 0; index < queue.length; index += 1) {
    const pid = queue[index];
    descendants.push(pid);
    queue.push(...(childrenByParent.get(pid) ?? []));
  }
  return descendants;
}

function addProcessListLine(childrenByParent: Map<number, number[]>, line: string): void {
  const parsed = parseProcessListLine(line);
  if (!parsed) {
    return;
  }

  const children = childrenByParent.get(parsed.parentPid);
  if (children) {
    children.push(parsed.pid);
  } else {
    childrenByParent.set(parsed.parentPid, [parsed.pid]);
  }
}

function parseProcessListLine(line: string): { pid: number; parentPid: number } | undefined {
  const match = line.trim().match(/^(\d+)\s+(\d+)$/);
  if (!match) {
    return undefined;
  }

  const pid = Number(match[1]);
  const parentPid = Number(match[2]);
  if (!Number.isInteger(pid) || !Number.isInteger(parentPid) || pid <= 0 || parentPid <= 0) {
    return undefined;
  }
  return { pid, parentPid };
}

async function runProcessListCommand(platform: NodeJS.Platform): Promise<string> {
  if (platform === "win32") {
    return await runWindowsProcessListCommand();
  }
  return await runPsCommand(["-eo", "pid=,ppid="]);
}

async function listProcessGroupPids(processGroupId: number): Promise<number[]> {
  let output: string;
  try {
    output = await runPsCommand(["-eo", "pid=,pgid="]);
  } catch {
    return [];
  }

  const pids: number[] = [];
  for (const line of output.split("\n")) {
    const parsed = parseProcessListLine(line);
    if (parsed?.parentPid === processGroupId) {
      pids.push(parsed.pid);
    }
  }
  return pids;
}

async function runPsCommand(args: string[]): Promise<string> {
  return await runCapturedCommand("ps", args, "ps");
}

async function runWindowsProcessListCommand(): Promise<string> {
  const command = [
    "Get-CimInstance Win32_Process |",
    'ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
  ].join(" ");
  return await runCapturedCommand(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    "powershell process list",
  );
}

async function runCapturedCommand(
  command: string,
  args: string[],
  description: string,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: { output: string } | { error: Error }): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if ("output" in result) {
        resolve(result.output);
      } else {
        reject(result.error);
      }
    };
    const timeout = setTimeout(() => {
      child.stdout.destroy();
      child.stderr.destroy();
      try {
        child.kill("SIGKILL");
      } catch {
        // best-effort cleanup for a stalled process-list command
      }
      child.unref();
      finish({
        error: new Error(`${description} did not exit within ${PROCESS_LIST_COMMAND_TIMEOUT_MS}ms`),
      });
    }, PROCESS_LIST_COMMAND_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      finish({ error });
    });
    child.once("close", (code, signal) => {
      if (code === 0) {
        finish({ output: stdout });
        return;
      }
      finish({
        error: new Error(
          `${description} exited with code ${code ?? "null"} signal ${signal ?? "null"}: ${stderr}`,
        ),
      });
    });
  });
}

async function killWindowsProcessTree(pid: number, signal: NodeJS.Signals): Promise<void> {
  const args = ["/pid", String(pid), "/t"];
  if (signal === "SIGKILL") {
    args.push("/f");
  }
  await new Promise<void>((resolve) => {
    const child = spawn("taskkill", args, {
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    });
    child.once("error", () => resolve());
    child.once("close", () => resolve());
  });
}

function sendSignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Processes can exit between discovery and signaling.
  }
}

function hasLiveProcessGroup(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch {
    return false;
  }
}

function hasLivePid(pids: Set<number>): boolean {
  let live = false;
  for (const pid of pids) {
    try {
      process.kill(pid, 0);
      live = true;
    } catch {
      pids.delete(pid);
    }
  }
  return live;
}

function waitMs(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}
