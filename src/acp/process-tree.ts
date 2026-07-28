import { spawn } from "node:child_process";

const PROCESS_TREE_POLL_MS = 25;

export type ManagedProcessTree = {
  rootPid: number | undefined;
  killProcessGroup: boolean;
  descendantPids: Set<number>;
  snapshotPromise?: Promise<void>;
};

export function createManagedProcessTree(
  rootPid: number | undefined,
  killProcessGroup: boolean,
): ManagedProcessTree {
  return {
    rootPid,
    killProcessGroup,
    descendantPids: new Set(),
  };
}

export function rememberProcessTreePids(tree: ManagedProcessTree): void {
  tree.snapshotPromise = captureProcessTreePids(tree, false);
}

export async function captureProcessTreePids(
  tree: ManagedProcessTree,
  rootRunning: boolean,
): Promise<void> {
  const rootPid = tree.rootPid;
  // POSIX ownership is the process group created at spawn. Descendants that
  // deliberately create another session are outside that ownership boundary.
  if (!tree.killProcessGroup || !rootPid || process.platform !== "win32") {
    return;
  }
  await waitForPriorSnapshot(tree, rootRunning);

  recordProcessTreePids(tree, await listDescendantPids(rootPid));
}

async function waitForPriorSnapshot(tree: ManagedProcessTree, rootRunning: boolean): Promise<void> {
  if (rootRunning) {
    return;
  }
  await tree.snapshotPromise?.catch(() => {
    // Process tree snapshots are best-effort because the root may already be gone.
  });
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
  if (process.platform === "win32") {
    await signalWindowsProcessTree(tree, rootRunning, signal);
    return;
  }
  signalPosixProcessTree(tree, signal);
}

export async function waitForProcessTreeExit(
  tree: ManagedProcessTree,
  rootRunning: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (rootRunning() || hasLiveManagedProcessTree(tree)) {
    if (Date.now() >= deadline) {
      return false;
    }
    await waitMs(Math.min(PROCESS_TREE_POLL_MS, Math.max(0, deadline - Date.now())));
  }
  return true;
}

async function signalWindowsProcessTree(
  tree: ManagedProcessTree,
  rootRunning: boolean,
  signal: NodeJS.Signals,
): Promise<void> {
  const rootPid = tree.rootPid;
  if (rootRunning && rootPid) {
    await killWindowsProcessTree(rootPid, signal);
    return;
  }
  for (const descendantPid of tree.descendantPids) {
    await killWindowsProcessTree(descendantPid, signal);
  }
}

function signalPosixProcessTree(tree: ManagedProcessTree, signal: NodeJS.Signals): void {
  const rootPid = tree.rootPid;
  if (rootPid && hasLiveProcessGroup(rootPid)) {
    sendSignal(-rootPid, signal);
  }
}

function hasLiveManagedProcessTree(tree: ManagedProcessTree): boolean {
  const rootPid = tree.rootPid;
  if (
    tree.killProcessGroup &&
    rootPid &&
    process.platform !== "win32" &&
    hasLiveProcessGroup(rootPid)
  ) {
    return true;
  }
  return process.platform === "win32" && hasLivePid(tree.descendantPids);
}

async function listDescendantPids(rootPid: number): Promise<number[]> {
  let output: string;
  try {
    output = await runProcessListCommand();
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

async function runProcessListCommand(): Promise<string> {
  if (process.platform === "win32") {
    return await runWindowsProcessListCommand();
  }
  return await runPsCommand(["-eo", "pid=,ppid="]);
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

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(
        new Error(
          `${description} exited with code ${code ?? "null"} signal ${signal ?? "null"}: ${stderr}`,
        ),
      );
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
