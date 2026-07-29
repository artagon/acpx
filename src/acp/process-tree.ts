import { spawn } from "node:child_process";
import fs from "node:fs/promises";

const PROCESS_TREE_POLL_MS = 25;
const PROCESS_LIST_COMMAND_TIMEOUT_MS = 1_000;
const WINDOWS_TRACKING_INITIAL_POLL_MS = 25;
const WINDOWS_TRACKING_MAX_POLL_MS = 1_000;
const WINDOWS_TRACKING_MAX_DURATION_MS = 10_000;
const WINDOWS_EPOCH_OFFSET_TICKS = 621_355_968_000_000_000n;

export type ManagedProcessTree = {
  rootPid: number | undefined;
  killProcessGroup: boolean;
  platform: NodeJS.Platform;
  descendantPids: Set<number>;
  descendantIdentities: Map<number, string>;
  rootIdentity?: string;
  rootIdentityFloor?: string;
  snapshotPromise?: Promise<void>;
};

export type ProcessListEntry = {
  pid: number;
  parentPid: number;
  processGroupId?: number;
  identity: string;
};

export async function readProcessIdentity(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
  const processList = await readProcessList(platform);
  return processList?.find((entry) => entry.pid === pid)?.identity;
}

export function createManagedProcessTree(
  rootPid: number | undefined,
  killProcessGroup: boolean,
  platform: NodeJS.Platform = process.platform,
  rootCreatedAfterMs?: number,
): ManagedProcessTree {
  return {
    rootPid,
    killProcessGroup,
    platform,
    descendantPids: new Set(),
    descendantIdentities: new Map(),
    rootIdentityFloor:
      platform === "win32" && rootCreatedAfterMs !== undefined
        ? windowsTicksFromUnixMs(rootCreatedAfterMs)
        : undefined,
  };
}

export function rememberProcessTreePids(tree: ManagedProcessTree): void {
  queueProcessTreeSnapshot(tree);
}

export function beginProcessTreeTracking(
  tree: ManagedProcessTree,
  rootRunning: () => boolean,
): void {
  if (tree.platform === "win32") {
    queueWindowsProcessTreeTracking(tree, rootRunning);
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

function queueWindowsProcessTreeTracking(
  tree: ManagedProcessTree,
  rootRunning: () => boolean,
): void {
  const priorSnapshot = tree.snapshotPromise;
  tree.snapshotPromise = (async () => {
    await priorSnapshot?.catch(() => {
      // Tracking can continue after an earlier best-effort snapshot failure.
    });
    const deadline = Date.now() + WINDOWS_TRACKING_MAX_DURATION_MS;
    let pollMs = WINDOWS_TRACKING_INITIAL_POLL_MS;
    while (rootRunning() && Date.now() < deadline) {
      const descendantCount = tree.descendantPids.size;
      await recordCurrentProcessTreePids(tree);
      if (rootRunning() && Date.now() < deadline) {
        await waitMs(pollMs);
        pollMs =
          tree.descendantPids.size > descendantCount
            ? WINDOWS_TRACKING_INITIAL_POLL_MS
            : Math.min(pollMs * 2, WINDOWS_TRACKING_MAX_POLL_MS);
      }
    }
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
      : await listOwnedPosixProcesses(tree);
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
    await refreshExitedProcessTreePids(tree);
  } else {
    await recordCurrentProcessTreePids(tree);
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

  const snapshot = collectWindowsDescendantProcesses(
    rootPid,
    tree.rootIdentity,
    processList,
    tree.rootIdentityFloor,
  );
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
  rootIdentityFloor?: string,
): { rootIdentity: string; descendants: ProcessListEntry[] } | undefined {
  const root = processList.find((entry) => entry.pid === rootPid);
  if (!root) {
    return undefined;
  }
  if (
    (expectedRootIdentity && expectedRootIdentity !== root.identity) ||
    (rootIdentityFloor && !isCreatedAtOrAfter(root.identity, rootIdentityFloor))
  ) {
    return undefined;
  }

  const childrenByParent = indexProcessesByParent(processList);
  return {
    rootIdentity: root.identity,
    descendants: walkValidatedDescendants(root, childrenByParent),
  };
}

function windowsTicksFromUnixMs(unixMs: number): string {
  return (BigInt(Math.floor(unixMs)) * 10_000n + WINDOWS_EPOCH_OFFSET_TICKS).toString();
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
    const childTime = Date.parse(childIdentity);
    const parentTime = Date.parse(parentIdentity);
    return Number.isFinite(childTime) && Number.isFinite(parentTime) && childTime >= parentTime;
  }
}

function parseWindowsProcessListLine(line: string): ProcessListEntry | undefined {
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

function parsePosixProcessListLine(line: string): ProcessListEntry | undefined {
  const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
  if (!match) {
    return undefined;
  }
  const pid = Number(match[1]);
  const parentPid = Number(match[2]);
  const processGroupId = Number(match[3]);
  const identity = match[4].trim();
  if (
    !isPositiveInteger(pid) ||
    !isPositiveInteger(parentPid) ||
    !isPositiveInteger(processGroupId) ||
    !identity
  ) {
    return undefined;
  }
  return { pid, parentPid, processGroupId, identity };
}

async function readProcessList(platform: NodeJS.Platform): Promise<ProcessListEntry[] | undefined> {
  if (platform === "linux") {
    return await readLinuxProcProcessList();
  }
  let output: string;
  try {
    output =
      platform === "win32"
        ? await runWindowsProcessListCommand()
        : await runPsCommand(["-eo", "pid=,ppid=,pgid=,lstart="]);
  } catch {
    return undefined;
  }
  const parseLine = platform === "win32" ? parseWindowsProcessListLine : parsePosixProcessListLine;
  return output
    .split("\n")
    .map((line) => parseLine(line))
    .filter((entry): entry is ProcessListEntry => entry !== undefined);
}

async function readLinuxProcProcessList(): Promise<ProcessListEntry[] | undefined> {
  let entries;
  try {
    entries = await fs.readdir("/proc", { withFileTypes: true });
  } catch {
    return undefined;
  }
  const processList = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map(async (entry) => {
        try {
          const stat = await fs.readFile(`/proc/${entry.name}/stat`, "utf8");
          return parseLinuxProcStat(stat);
        } catch {
          return undefined;
        }
      }),
  );
  return processList.filter((entry): entry is ProcessListEntry => entry !== undefined);
}

function parseLinuxProcStat(stat: string): ProcessListEntry | undefined {
  const commandEnd = stat.lastIndexOf(")");
  const commandStart = stat.indexOf("(");
  if (commandStart <= 0 || commandEnd <= commandStart) {
    return undefined;
  }
  const pid = Number(stat.slice(0, commandStart).trim());
  const fields = stat
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/);
  const parentPid = Number(fields[1]);
  const processGroupId = Number(fields[2]);
  const startTime = fields[19];
  if (
    !isPositiveInteger(pid) ||
    !isPositiveInteger(parentPid) ||
    !isPositiveInteger(processGroupId) ||
    !isNumericIdentity(startTime)
  ) {
    return undefined;
  }
  return { pid, parentPid, processGroupId, identity: startTime };
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function isNumericIdentity(value: string | undefined): value is string {
  return value !== undefined && /^\d+$/.test(value);
}

async function listOwnedPosixProcesses(tree: ManagedProcessTree): Promise<ProcessListEntry[]> {
  const rootPid = tree.rootPid;
  if (!rootPid) {
    return [];
  }
  const processList = await readProcessList(tree.platform);
  if (!processList) {
    return [];
  }
  const ownedByPid = new Map(
    processList
      .filter((entry) => entry.processGroupId === rootPid)
      .map((entry) => [entry.pid, entry]),
  );
  const root = processList.find((entry) => entry.pid === rootPid);
  if (
    root &&
    (!tree.rootIdentity || tree.rootIdentity === root.identity) &&
    root.processGroupId === rootPid
  ) {
    tree.rootIdentity = root.identity;
    for (const descendant of walkValidatedDescendants(root, indexProcessesByParent(processList))) {
      ownedByPid.set(descendant.pid, descendant);
    }
  }
  return [...ownedByPid.values()];
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
    if (!current || current.identity !== capturedIdentity) {
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
  const currentGroup = processList.filter((entry) => entry.processGroupId === rootPid);
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
  return await runCapturedCommand("ps", args, "ps", {
    ...process.env,
    LANG: "C",
    LC_ALL: "C",
  });
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
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      env,
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
