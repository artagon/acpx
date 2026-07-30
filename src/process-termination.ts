import { readProcessIdentity } from "./acp/process-tree.js";
import { isProcessAlive } from "./process-liveness.js";

// The queue owner may spend 2.6 seconds closing its ACP process tree. Identity
// checks can each add a bounded process-list call, so retain the existing
// headroom before escalating from SIGTERM.
const PROCESS_SIGTERM_GRACE_MS = 6_500;
const PROCESS_SIGKILL_GRACE_MS = 1_500;
const PROCESS_POLL_MS = 50;

export async function terminateProcess(
  pid: number,
  expectedProcessIdentity?: string,
  validateProcess: () => Promise<boolean> = async () => true,
): Promise<boolean> {
  if (!isProcessAlive(pid)) {
    return false;
  }
  if (!(await processMayBeSignaled(pid, expectedProcessIdentity, validateProcess))) {
    return false;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return false;
  }

  if (await waitForProcessExit(pid, PROCESS_SIGTERM_GRACE_MS)) {
    return true;
  }
  if (!(await processMayBeSignaled(pid, expectedProcessIdentity, validateProcess))) {
    return true;
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return false;
  }

  return await waitForProcessExit(pid, PROCESS_SIGKILL_GRACE_MS);
}

async function processMayBeSignaled(
  pid: number,
  expectedProcessIdentity: string | undefined,
  validateProcess: () => Promise<boolean>,
): Promise<boolean> {
  if (expectedProcessIdentity !== undefined) {
    return await processIdentityMatches(pid, expectedProcessIdentity);
  }
  return await validateProcess();
}

async function processIdentityMatches(pid: number, expectedIdentity: string): Promise<boolean> {
  return (await readProcessIdentity(pid)) === expectedIdentity;
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() <= deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, PROCESS_POLL_MS);
    });
  }

  return !isProcessAlive(pid);
}
