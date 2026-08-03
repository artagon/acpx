import { spawn } from "node:child_process";
import fs from "node:fs/promises";

const PROCESS_TREE_POLL_MS = 25;
const PROCESS_LIST_COMMAND_TIMEOUT_MS = 1_000;
const WINDOWS_PROCESS_LIST_COMMAND_TIMEOUT_MS = 5_000;
const PROCESS_TREE_TRACKING_INITIAL_POLL_MS = 25;
const PROCESS_TREE_TRACKING_MAX_POLL_MS = 1_000;
const PROCESS_TREE_TRACKING_MAX_DURATION_MS = 10_000;
const WINDOWS_EPOCH_OFFSET_TICKS = 621_355_968_000_000_000n;

export type ManagedProcessTree = {
  rootPid: number | undefined;
  killProcessGroup: boolean;
  platform: NodeJS.Platform;
  descendantPids: Set<number>;
  descendantIdentities: Map<number, string>;
  rootIdentity?: string;
  rootIdentityFloor?: string;
  rootRunning?: () => boolean;
  snapshotPromise?: Promise<void>;
  enumerationHealthy?: boolean;
};

type OwnedProcessSnapshot = Readonly<{
  ownershipObserved: boolean;
  processes: ProcessListEntry[];
}>;

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
  if (!tree.killProcessGroup || !tree.rootPid) {
    return;
  }
  tree.rootRunning = rootRunning;
  queueProcessTreeTracking(tree, rootRunning);
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

export async function isProcessTreeEnumerationHealthy(tree: ManagedProcessTree): Promise<boolean> {
  await waitForPriorSnapshot(tree);
  return tree.enumerationHealthy === true;
}

async function waitForPriorSnapshot(tree: ManagedProcessTree): Promise<void> {
  await tree.snapshotPromise?.catch(() => {
    markEnumerationUnhealthy(tree);
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

function queueProcessTreeTracking(tree: ManagedProcessTree, rootRunning: () => boolean): void {
  const priorSnapshot = tree.snapshotPromise;
  tree.snapshotPromise = (async () => {
    await priorSnapshot?.catch(() => {
      // Tracking can continue after an earlier best-effort snapshot failure.
    });
    const deadline = Date.now() + PROCESS_TREE_TRACKING_MAX_DURATION_MS;
    let pollMs = PROCESS_TREE_TRACKING_INITIAL_POLL_MS;
    while (rootRunning() && Date.now() < deadline) {
      const descendantCount = tree.descendantPids.size;
      await recordCurrentProcessTreePids(tree);
      if (rootRunning() && Date.now() < deadline) {
        await waitMs(pollMs);
        pollMs =
          tree.descendantPids.size > descendantCount
            ? PROCESS_TREE_TRACKING_INITIAL_POLL_MS
            : Math.min(pollMs * 2, PROCESS_TREE_TRACKING_MAX_POLL_MS);
      }
    }
  })();
}

async function recordCurrentProcessTreePids(tree: ManagedProcessTree): Promise<void> {
  const rootPid = tree.rootPid;
  if (!tree.killProcessGroup || !rootPid) {
    return;
  }
  if (!isTrackedRootRunning(tree)) {
    return;
  }
  const priorRootIdentity = tree.rootIdentity;
  const snapshot =
    tree.platform === "win32"
      ? await listDescendantProcesses(tree)
      : await listOwnedPosixProcesses(tree);
  if (snapshot === undefined) {
    markEnumerationUnhealthy(tree);
    return;
  }
  markEnumerationHealthy(tree);
  retainTrustedProcessTreeSnapshot(tree, snapshot, priorRootIdentity);
}

function retainTrustedProcessTreeSnapshot(
  tree: ManagedProcessTree,
  snapshot: OwnedProcessSnapshot,
  priorRootIdentity: string | undefined,
): void {
  const rootStillRunning = isTrackedRootRunning(tree);
  if (snapshot.ownershipObserved && (rootStillRunning || priorRootIdentity !== undefined)) {
    recordProcessTreePids(tree, snapshot.processes);
  }
  if (!rootStillRunning) {
    tree.rootIdentity = priorRootIdentity;
  }
}

function isTrackedRootRunning(tree: ManagedProcessTree): boolean {
  return tree.rootRunning === undefined || tree.rootRunning();
}

function markEnumerationHealthy(tree: ManagedProcessTree): void {
  tree.enumerationHealthy ??= true;
}

function markEnumerationUnhealthy(tree: ManagedProcessTree): void {
  tree.enumerationHealthy = false;
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
  rootRunning: boolean | (() => boolean),
  signal: NodeJS.Signals,
): Promise<void> {
  const rootPid = tree.rootPid;
  if (!tree.killProcessGroup || !rootPid) {
    if (rootPid) {
      sendSignal(rootPid, signal);
    }
    return;
  }

  let rootIsRunning = resolveRootRunning(rootRunning);
  if (!rootIsRunning) {
    await captureProcessTreePids(tree, false);
    await refreshExitedProcessTreePids(tree);
  } else {
    await recordCurrentProcessTreePids(tree);
  }
  rootIsRunning = resolveRootRunning(rootRunning);
  for (const target of resolveProcessTreeSignalTargets(tree, rootIsRunning)) {
    if (target.tree) {
      await killWindowsProcessTree(target.pid, signal);
    } else {
      sendSignal(target.pid, signal);
    }
  }
}

function resolveRootRunning(rootRunning: boolean | (() => boolean)): boolean {
  return typeof rootRunning === "function" ? rootRunning() : rootRunning;
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
    if (shouldRefreshExitedTree(tree, rootIsRunning, finalSignal)) {
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

function shouldRefreshExitedTree(
  tree: ManagedProcessTree,
  rootIsRunning: boolean,
  finalSignal: NodeJS.Signals | undefined,
): boolean {
  return !rootIsRunning && Boolean(finalSignal || !hasLiveManagedProcessTree(tree, false));
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
    signalUnsignaledProcessPids(tree, finalSignal, signaledIdentities);
  }
  return false;
}

function signalUnsignaledProcessPids(
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

async function listDescendantProcesses(
  tree: ManagedProcessTree,
): Promise<OwnedProcessSnapshot | undefined> {
  const rootPid = tree.rootPid;
  if (!rootPid) {
    return { ownershipObserved: false, processes: [] };
  }
  const processList = await readProcessList(tree.platform);
  if (!processList) {
    return undefined;
  }

  const snapshot = collectWindowsDescendantProcesses(
    rootPid,
    tree.rootIdentity,
    processList,
    tree.rootIdentityFloor,
  );
  if (!snapshot) {
    return { ownershipObserved: false, processes: [] };
  }
  tree.rootIdentity = snapshot.rootIdentity;
  return { ownershipObserved: true, processes: snapshot.descendants };
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

async function listOwnedPosixProcesses(
  tree: ManagedProcessTree,
): Promise<OwnedProcessSnapshot | undefined> {
  const rootPid = tree.rootPid;
  if (!rootPid) {
    return { ownershipObserved: false, processes: [] };
  }
  const processList = await readProcessList(tree.platform);
  if (!processList) {
    return undefined;
  }
  const root = processList.find((entry) => entry.pid === rootPid);
  if (!posixRootIdentityMatches(tree, root)) {
    return { ownershipObserved: false, processes: [] };
  }
  const ownedByPid = new Map(
    processList
      .filter((entry) => entry.processGroupId === rootPid)
      .map((entry) => [entry.pid, entry]),
  );
  if (root) {
    tree.rootIdentity = root.identity;
    for (const descendant of walkValidatedDescendants(root, indexProcessesByParent(processList))) {
      ownedByPid.set(descendant.pid, descendant);
    }
  }
  return {
    ownershipObserved: root !== undefined || ownedByPid.size > 0,
    processes: [...ownedByPid.values()],
  };
}

function posixRootIdentityMatches(
  tree: ManagedProcessTree,
  root: ProcessListEntry | undefined,
): boolean {
  return (
    !root ||
    (root.processGroupId === tree.rootPid &&
      (tree.rootIdentity === undefined || tree.rootIdentity === root.identity))
  );
}

async function refreshExitedProcessTreePids(tree: ManagedProcessTree): Promise<boolean> {
  const rootPid = tree.rootPid;
  if (!tree.killProcessGroup || !rootPid) {
    return true;
  }
  const processList = await readProcessList(tree.platform);
  if (!processList) {
    markEnumerationUnhealthy(tree);
    return false;
  }
  const currentByPid = new Map(processList.map((entry) => [entry.pid, entry]));
  retainCurrentProcessTreePids(tree, currentByPid);
  if (tree.platform !== "win32") {
    discoverRememberedPosixDescendants(tree, currentByPid, processList);
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

function discoverRememberedPosixDescendants(
  tree: ManagedProcessTree,
  currentByPid: Map<number, ProcessListEntry>,
  processList: ProcessListEntry[],
): void {
  const childrenByParent = indexProcessesByParent(processList);
  const rememberedRoots = [...tree.descendantPids]
    .map((pid) => currentByPid.get(pid))
    .filter((entry): entry is ProcessListEntry => entry !== undefined);
  for (const rememberedRoot of rememberedRoots) {
    recordProcessTreePids(tree, walkValidatedDescendants(rememberedRoot, childrenByParent));
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
    // PID/PGID was recycled. Do not adopt ambiguous group members, but retain
    // descendants whose identities were validated by retainCurrentProcessTreePids.
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
    undefined,
    WINDOWS_PROCESS_LIST_COMMAND_TIMEOUT_MS,
  );
}

async function runCapturedCommand(
  command: string,
  args: string[],
  description: string,
  env?: NodeJS.ProcessEnv,
  timeoutMs = PROCESS_LIST_COMMAND_TIMEOUT_MS,
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
        error: new Error(`${description} did not exit within ${timeoutMs}ms`),
      });
    }, timeoutMs);

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
