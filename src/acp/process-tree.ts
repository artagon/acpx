import { spawn } from "node:child_process";

const PROCESS_TREE_POLL_MS = 25;
const PROCESS_LIST_COMMAND_TIMEOUT_MS = 1_000;

export type ManagedProcessTree = {
  rootPid: number | undefined;
  killProcessGroup: boolean;
  platform: NodeJS.Platform;
  descendantPids: Set<number>;
  descendantIdentities: Map<number, string>;
  rootIdentity?: string;
  snapshotPromise?: Promise<void>;
};

export type ProcessListEntry = {
  pid: number;
  parentPid: number;
  identity: string;
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
    descendantIdentities: new Map(),
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
  const processes =
    tree.platform === "win32"
      ? await listDescendantProcesses(tree)
      : await listProcessGroupEntries(rootPid, tree.platform);
  recordProcessTreePids(tree, processes);
}

function recordProcessTreePids(tree: ManagedProcessTree, processes: ProcessListEntry[]): void {
  for (const processEntry of processes) {
    if (processEntry.pid === tree.rootPid) {
      continue;
    }
    tree.descendantPids.add(processEntry.pid);
    tree.descendantIdentities.set(processEntry.pid, processEntry.identity);
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

  if (!rootRunning) {
    await captureProcessTreePids(tree, false);
    const refreshed = await refreshExitedProcessTreePids(tree);
    if (!refreshed) {
      tree.descendantPids.clear();
      tree.descendantIdentities.clear();
    }
  }
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
  finalSignal?: NodeJS.Signals,
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  const signaledIdentities = new Set<string>();
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
      if (await exitedTreeRemainsEmptyAfterRefresh(tree, finalSignal, signaledIdentities)) {
        return true;
      }
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

async function exitedTreeRemainsEmptyAfterRefresh(
  tree: ManagedProcessTree,
  finalSignal: NodeJS.Signals | undefined,
  signaledIdentities: Set<string>,
): Promise<boolean> {
  if (!(await refreshExitedProcessTreePids(tree))) {
    return false;
  }
  if (!hasLiveManagedProcessTree(tree, false)) {
    return true;
  }
  if (finalSignal) {
    signalNewlyDiscoveredProcessPids(tree, finalSignal, signaledIdentities);
  }
  return false;
}

function signalNewlyDiscoveredProcessPids(
  tree: ManagedProcessTree,
  signal: NodeJS.Signals,
  signaledIdentities: Set<string>,
): void {
  for (const pid of tree.descendantPids) {
    const identity = tree.descendantIdentities.get(pid);
    const signalKey = `${pid}:${identity ?? ""}`;
    if (!signaledIdentities.has(signalKey)) {
      sendSignal(pid, signal);
      signaledIdentities.add(signalKey);
    }
  }
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
  return hasLivePid(tree);
}

async function listDescendantProcesses(tree: ManagedProcessTree): Promise<ProcessListEntry[]> {
  const rootPid = tree.rootPid;
  if (!rootPid) {
    return [];
  }
  const processList = await readProcessList(tree.platform);
  if (!processList) {
    return [];
  }

  const snapshot = collectWindowsDescendantProcesses(rootPid, tree.rootIdentity, processList);
  if (!snapshot) {
    return [];
  }
  tree.rootIdentity = snapshot.rootIdentity;
  return snapshot.descendants;
}

export function collectWindowsDescendantProcesses(
  rootPid: number,
  expectedRootIdentity: string | undefined,
  processList: ProcessListEntry[],
): { rootIdentity: string; descendants: ProcessListEntry[] } | undefined {
  const root = processList.find((entry) => entry.pid === rootPid);
  if (!root || (expectedRootIdentity && expectedRootIdentity !== root.identity)) {
    return undefined;
  }

  const childrenByParent = indexProcessesByParent(processList);
  return {
    rootIdentity: root.identity,
    descendants: walkValidatedDescendants(root, childrenByParent),
  };
}

function indexProcessesByParent(processList: ProcessListEntry[]): Map<number, ProcessListEntry[]> {
  const childrenByParent = new Map<number, ProcessListEntry[]>();
  for (const processEntry of processList) {
    const children = childrenByParent.get(processEntry.parentPid);
    if (children) {
      children.push(processEntry);
    } else {
      childrenByParent.set(processEntry.parentPid, [processEntry]);
    }
  }
  return childrenByParent;
}

function walkValidatedDescendants(
  root: ProcessListEntry,
  childrenByParent: Map<number, ProcessListEntry[]>,
): ProcessListEntry[] {
  const descendants: ProcessListEntry[] = [];
  const visited = new Set([root.pid]);
  const queue = [root];
  for (let index = 0; index < queue.length; index += 1) {
    const parent = queue[index];
    for (const child of childrenByParent.get(parent.pid) ?? []) {
      if (visited.has(child.pid) || !isCreatedAtOrAfter(child.identity, parent.identity)) {
        continue;
      }
      visited.add(child.pid);
      descendants.push(child);
      queue.push(child);
    }
  }
  return descendants;
}

function isCreatedAtOrAfter(childIdentity: string, parentIdentity: string): boolean {
  try {
    return BigInt(childIdentity) >= BigInt(parentIdentity);
  } catch {
    return false;
  }
}

function parseProcessListLine(line: string): ProcessListEntry | undefined {
  const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
  if (!match) {
    return undefined;
  }

  const pid = Number(match[1]);
  const parentPid = Number(match[2]);
  const identity = match[3].trim();
  if (!Number.isInteger(pid) || !Number.isInteger(parentPid) || pid <= 0 || parentPid <= 0) {
    return undefined;
  }
  if (!identity) {
    return undefined;
  }
  return { pid, parentPid, identity };
}

async function readProcessList(platform: NodeJS.Platform): Promise<ProcessListEntry[] | undefined> {
  let output: string;
  try {
    output =
      platform === "win32"
        ? await runWindowsProcessListCommand()
        : await runPsCommand(["-eo", "pid=,pgid=,lstart="]);
  } catch {
    return undefined;
  }
  return output
    .split("\n")
    .map((line) => parseProcessListLine(line))
    .filter((entry): entry is ProcessListEntry => entry !== undefined);
}

async function listProcessGroupEntries(
  processGroupId: number,
  platform: NodeJS.Platform,
): Promise<ProcessListEntry[]> {
  const processList = await readProcessList(platform);
  if (!processList) {
    return [];
  }
  return processList.filter((entry) => entry.parentPid === processGroupId);
}

async function refreshExitedProcessTreePids(tree: ManagedProcessTree): Promise<boolean> {
  const rootPid = tree.rootPid;
  if (!tree.killProcessGroup || !rootPid) {
    return true;
  }
  const processList = await readProcessList(tree.platform);
  if (!processList) {
    return false;
  }
  const currentByPid = new Map(processList.map((entry) => [entry.pid, entry]));
  retainCurrentProcessTreePids(tree, currentByPid);
  if (tree.platform !== "win32") {
    discoverCurrentPosixGroupMembers(tree, rootPid, processList);
  }
  return true;
}

function retainCurrentProcessTreePids(
  tree: ManagedProcessTree,
  currentByPid: Map<number, ProcessListEntry>,
): void {
  for (const pid of tree.descendantPids) {
    const current = currentByPid.get(pid);
    const capturedIdentity = tree.descendantIdentities.get(pid);
    const remainsInOwnedGroup = tree.platform === "win32" || current?.parentPid === tree.rootPid;
    if (!current || current.identity !== capturedIdentity || !remainsInOwnedGroup) {
      tree.descendantPids.delete(pid);
      tree.descendantIdentities.delete(pid);
    }
  }
}

function discoverCurrentPosixGroupMembers(
  tree: ManagedProcessTree,
  rootPid: number,
  processList: ProcessListEntry[],
): void {
  const currentGroup = processList.filter((entry) => entry.parentPid === rootPid);
  if (currentGroup.some((entry) => entry.pid === rootPid)) {
    // A live process whose PID equals the old group leader means the numeric
    // PID/PGID was recycled after the owned group became empty.
    tree.descendantPids.clear();
    tree.descendantIdentities.clear();
    return;
  }
  recordProcessTreePids(tree, currentGroup);
}

async function runPsCommand(args: string[]): Promise<string> {
  return await runCapturedCommand("ps", args, "ps");
}

async function runWindowsProcessListCommand(): Promise<string> {
  const command = [
    "Get-CimInstance Win32_Process |",
    'ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CreationDate.ToUniversalTime().Ticks)" }',
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

function hasLivePid(tree: ManagedProcessTree): boolean {
  let live = false;
  for (const pid of tree.descendantPids) {
    try {
      process.kill(pid, 0);
      live = true;
    } catch {
      tree.descendantPids.delete(pid);
      tree.descendantIdentities.delete(pid);
    }
  }
  return live;
}

function waitMs(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}
