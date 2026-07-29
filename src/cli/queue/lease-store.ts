import { randomInt, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import { readProcessIdentity } from "../../acp/process-tree.js";
import { isProcessAlive } from "../../process-liveness.js";
import { queueBaseDir, queueLockFilePath, queueSocketBaseDir, queueSocketPath } from "./paths.js";

export { isProcessAlive } from "../../process-liveness.js";

// Budget for graceful SIGTERM shutdown of a queue-owner process.
// The owner runs AcpClient.close() during shutdown:
//   stdin-close grace (100 ms) + SIGTERM wait (1 500 ms) + SIGKILL wait (1 000 ms) = 2 600 ms worst case.
// Process identity validation can add two bounded 1 000 ms process-list calls.
// Add ~1 900 ms of headroom for those calls, event-loop latency, and process startup overhead.
// If the owner does not exit within this window we escalate to SIGKILL.
const PROCESS_SIGTERM_GRACE_MS = 6_500;
// After SIGKILL the OS terminates the process almost immediately; 1 500 ms is generous.
const PROCESS_SIGKILL_GRACE_MS = 1_500;
const PROCESS_POLL_MS = 50;
const QUEUE_OWNER_CLEANUP_CLAIM_WAIT_MS = 1_000;
const QUEUE_OWNER_CLEANUP_CLAIM_POLL_MS = 10;
const QUEUE_OWNER_STALE_HEARTBEAT_MS = 15_000;
const QUEUE_OWNER_MALFORMED_LOCK_STALE_MS = QUEUE_OWNER_STALE_HEARTBEAT_MS;

export type QueueOwnerRecord = {
  pid: number;
  sessionId: string;
  socketPath: string;
  createdAt: string;
  heartbeatAt: string;
  ownerGeneration: number;
  queueDepth: number;
  mcpConfigPath?: string;
  mcpConfigFingerprint?: string;
};

export type QueueOwnerLease = {
  sessionId: string;
  lockPath: string;
  socketPath: string;
  createdAt: string;
  ownerGeneration: number;
  mcpConfigPath?: string;
  mcpConfigFingerprint?: string;
};

type QueueOwnerLeaseState = {
  pendingRefresh: Promise<void>;
  released: boolean;
  releasePromise?: Promise<void>;
};

const queueOwnerLeaseStates = new WeakMap<QueueOwnerLease, QueueOwnerLeaseState>();

export type QueueOwnerStatus = {
  pid: number;
  socketPath: string;
  heartbeatAt: string;
  ownerGeneration: number;
  queueDepth: number;
  alive: boolean;
  stale: boolean;
};

function parseQueueOwnerRecord(raw: unknown): QueueOwnerRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;

  if (!hasValidQueueOwnerRecordFields(record)) {
    return null;
  }

  return {
    pid: record.pid,
    sessionId: record.sessionId,
    socketPath: record.socketPath,
    createdAt: record.createdAt,
    heartbeatAt: record.heartbeatAt,
    ownerGeneration: record.ownerGeneration,
    queueDepth: record.queueDepth,
    ...(typeof record.mcpConfigPath === "string" ? { mcpConfigPath: record.mcpConfigPath } : {}),
    ...(typeof record.mcpConfigFingerprint === "string"
      ? { mcpConfigFingerprint: record.mcpConfigFingerprint }
      : {}),
  };
}

function hasValidQueueOwnerRecordFields(record: Record<string, unknown>): record is Record<
  string,
  unknown
> & {
  pid: number;
  sessionId: string;
  socketPath: string;
  createdAt: string;
  heartbeatAt: string;
  ownerGeneration: number;
  queueDepth: number;
} {
  return (
    isPositiveInteger(record.pid) &&
    typeof record.sessionId === "string" &&
    typeof record.socketPath === "string" &&
    typeof record.createdAt === "string" &&
    typeof record.heartbeatAt === "string" &&
    isPositiveInteger(record.ownerGeneration) &&
    isNonNegativeInteger(record.queueDepth)
  );
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function createOwnerGeneration(): number {
  return randomInt(1, 2 ** 48);
}

function nowIso(): string {
  return new Date().toISOString();
}

function isQueueOwnerHeartbeatStale(owner: QueueOwnerRecord): boolean {
  const heartbeatMs = Date.parse(owner.heartbeatAt);
  if (!Number.isFinite(heartbeatMs)) {
    return true;
  }
  return Date.now() - heartbeatMs > QUEUE_OWNER_STALE_HEARTBEAT_MS;
}

async function ensureQueueDir(): Promise<void> {
  const baseDir = queueBaseDir();
  try {
    await fs.mkdir(baseDir, { recursive: true, mode: 0o700 });
    await fs.chmod(baseDir, 0o700);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to prepare queue directory ${baseDir}: ${message}`, {
      cause: error,
    });
  }
  const socketDir = queueSocketBaseDir();
  if (socketDir) {
    try {
      await fs.mkdir(socketDir, { recursive: true, mode: 0o700 });
      await fs.chmod(socketDir, 0o700);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to prepare queue socket directory ${socketDir}: ${message}`, {
        cause: error,
      });
    }
  }
}

async function removeSocketFile(socketPath: string): Promise<void> {
  if (process.platform === "win32") {
    return;
  }

  try {
    await fs.unlink(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() <= deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await waitMs(PROCESS_POLL_MS);
  }

  return !isProcessAlive(pid);
}

async function cleanupStaleQueueOwner(
  sessionId: string,
  owner: QueueOwnerRecord | undefined,
  expectedLockStat?: Stats,
): Promise<boolean> {
  const lockPath = queueLockFilePath(sessionId);
  const socketPath = owner?.socketPath ?? queueSocketPath(sessionId);
  const claim = await claimQueueOwnerLockForCleanup(
    lockPath,
    owner?.ownerGeneration,
    expectedLockStat,
  );
  if (!claim) {
    return false;
  }

  try {
    if (owner && isProcessAlive(owner.pid)) {
      await terminateProcess(owner.pid);
    }
    await removeClaimedQueueOwnerFiles(claim, socketPath, lockPath);
    return true;
  } finally {
    await claim.release();
  }
}

async function claimQueueOwnerLockForCleanup(
  lockPath: string,
  expectedGeneration?: number,
  expectedStat?: Stats,
): Promise<QueueOwnerLockClaim | undefined> {
  const deadline = Date.now() + QUEUE_OWNER_CLEANUP_CLAIM_WAIT_MS;
  do {
    const claim = await claimQueueOwnerLock(lockPath, expectedGeneration, expectedStat);
    if (claim) {
      return claim;
    }
    await waitMs(QUEUE_OWNER_CLEANUP_CLAIM_POLL_MS);
  } while (Date.now() < deadline);
  return undefined;
}

async function removeClaimedQueueOwnerFiles(
  claim: QueueOwnerLockClaim,
  socketPath: string,
  lockPath: string,
): Promise<void> {
  if (!(await claim.isHeld())) {
    return;
  }
  await removeSocketFile(socketPath).catch(() => {
    // ignore stale socket cleanup failures
  });
  if (await claim.isHeld()) {
    await unlinkIfPresent(lockPath);
  }
}

function queueOwnerLockTempPath(lockPath: string): string {
  return `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
}

async function writeQueueOwnerFileAtomically(
  lockPath: string,
  payload: string,
  operation: "create" | "replace",
): Promise<void> {
  const tempPath = queueOwnerLockTempPath(lockPath);
  try {
    await fs.writeFile(tempPath, payload, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    if (operation === "create") {
      await fs.link(tempPath, lockPath);
    } else {
      await fs.rename(tempPath, lockPath);
    }
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {
      // best-effort cleanup after publication or a failed collision
    });
  }
}

async function staleMalformedQueueOwnerLockStat(lockPath: string): Promise<Stats | undefined> {
  try {
    const stat = await fs.lstat(lockPath);
    return Date.now() - stat.mtimeMs > QUEUE_OWNER_MALFORMED_LOCK_STALE_MS ? stat : undefined;
  } catch {
    return undefined;
  }
}

async function retireStaleQueueOwner(
  sessionId: string,
  owner: QueueOwnerRecord | undefined,
): Promise<boolean> {
  return await cleanupStaleQueueOwner(sessionId, owner);
}

export type QueueOwnerLockClaim = {
  isHeld: () => Promise<boolean>;
  release: () => Promise<void>;
};

type QueueOwnerLockClaimRecord = {
  claimId: string;
  pid: number;
  processIdentity?: string;
};

let currentProcessIdentityPromise: Promise<string | undefined> | undefined;

function queueOwnerLockClaimPath(lockPath: string, stat: Stats): string {
  return `${lockPath}.claim-${stat.dev}-${stat.ino}`;
}

export async function claimQueueOwnerLock(
  lockPath: string,
  expectedGeneration?: number,
  expectedStat?: Stats,
): Promise<QueueOwnerLockClaim | undefined> {
  const observedStat = expectedStat ?? (await lstatIfPresent(lockPath));
  if (!observedStat) {
    return undefined;
  }
  const claimPath = queueOwnerLockClaimPath(lockPath, observedStat);
  const claimRecord = await currentQueueOwnerLockClaimRecord();
  if (!(await createOrRecoverQueueOwnerLockClaim(claimPath, claimRecord))) {
    return undefined;
  }
  const claim = {
    isHeld: async (): Promise<boolean> => {
      const current = await readQueueOwnerLockClaimRecord(claimPath);
      return current?.claimId === claimRecord.claimId;
    },
    release: async (): Promise<void> => {
      if ((await readQueueOwnerLockClaimRecord(claimPath))?.claimId === claimRecord.claimId) {
        await unlinkIfPresent(claimPath);
      }
    },
  };
  if (!(await validateQueueOwnerLockClaim(lockPath, observedStat, expectedGeneration, claim))) {
    return undefined;
  }
  return claim;
}

async function currentQueueOwnerLockClaimRecord(): Promise<QueueOwnerLockClaimRecord> {
  currentProcessIdentityPromise ??= readProcessIdentity(process.pid);
  return {
    claimId: randomUUID(),
    pid: process.pid,
    processIdentity: await currentProcessIdentityPromise,
  };
}

async function createOrRecoverQueueOwnerLockClaim(
  claimPath: string,
  claimRecord: QueueOwnerLockClaimRecord,
): Promise<boolean> {
  if (await tryCreateQueueOwnerLockClaim(claimPath, claimRecord)) {
    return true;
  }
  if (!(await recoverStaleQueueOwnerLockClaim(claimPath))) {
    return false;
  }
  return await tryCreateQueueOwnerLockClaim(claimPath, claimRecord);
}

async function tryCreateQueueOwnerLockClaim(
  claimPath: string,
  claimRecord: QueueOwnerLockClaimRecord,
): Promise<boolean> {
  try {
    await fs.writeFile(claimPath, `${JSON.stringify(claimRecord)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOENT") {
      return false;
    }
    throw error;
  }
  return true;
}

async function recoverStaleQueueOwnerLockClaim(claimPath: string): Promise<boolean> {
  const observedStat = await lstatIfPresent(claimPath);
  if (!observedStat || !(await queueOwnerLockClaimIsStale(claimPath, observedStat))) {
    return false;
  }

  const quarantinePath = `${claimPath}.reap-${process.pid}-${randomUUID()}`;
  try {
    await fs.rename(claimPath, quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return true;
    }
    throw error;
  }

  const movedStat = await lstatIfPresent(quarantinePath);
  if (!movedStat || !sameFileIdentity(observedStat, movedStat)) {
    await restoreDisplacedQueueOwnerLockClaim(quarantinePath, claimPath);
    return false;
  }
  if (!(await queueOwnerLockClaimIsStale(quarantinePath, movedStat))) {
    await restoreDisplacedQueueOwnerLockClaim(quarantinePath, claimPath);
    return false;
  }
  await unlinkIfPresent(quarantinePath);
  return true;
}

async function restoreDisplacedQueueOwnerLockClaim(
  quarantinePath: string,
  claimPath: string,
): Promise<void> {
  try {
    await fs.rename(quarantinePath, claimPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    await unlinkIfPresent(quarantinePath);
  }
}

async function queueOwnerLockClaimIsStale(claimPath: string, stat: Stats): Promise<boolean> {
  const claimRecord = await readQueueOwnerLockClaimRecord(claimPath);
  if (!claimRecord) {
    return Date.now() - stat.mtimeMs > QUEUE_OWNER_MALFORMED_LOCK_STALE_MS;
  }
  if (!claimantProcessIsAlive(claimRecord.pid)) {
    return true;
  }
  if (!claimRecord.processIdentity) {
    return Date.now() - stat.mtimeMs > QUEUE_OWNER_MALFORMED_LOCK_STALE_MS;
  }
  const currentIdentity = await readProcessIdentity(claimRecord.pid);
  return currentIdentity !== undefined && currentIdentity !== claimRecord.processIdentity;
}

function claimantProcessIsAlive(pid: number): boolean {
  return pid === process.pid || isProcessAlive(pid);
}

async function readQueueOwnerLockClaimRecord(
  claimPath: string,
): Promise<QueueOwnerLockClaimRecord | undefined> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(claimPath, "utf8"));
    return parseQueueOwnerLockClaimRecord(parsed);
  } catch {
    return undefined;
  }
}

function parseQueueOwnerLockClaimRecord(value: unknown): QueueOwnerLockClaimRecord | undefined {
  if (!isQueueOwnerLockClaimRecord(value)) {
    return undefined;
  }
  return {
    claimId: value.claimId,
    pid: value.pid,
    processIdentity: value.processIdentity,
  };
}

function isQueueOwnerLockClaimRecord(value: unknown): value is QueueOwnerLockClaimRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    isNonEmptyString(candidate.claimId) &&
    isPositiveInteger(candidate.pid) &&
    isOptionalString(candidate.processIdentity)
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

async function validateQueueOwnerLockClaim(
  lockPath: string,
  observedStat: Stats,
  expectedGeneration: number | undefined,
  claim: QueueOwnerLockClaim,
): Promise<boolean> {
  let valid = false;
  try {
    const currentStat = await lstatIfPresent(lockPath);
    valid = Boolean(currentStat && sameFileIdentity(observedStat, currentStat));
    if (valid && expectedGeneration !== undefined) {
      const claimedOwner = await readQueueOwnerRecordAtPath(lockPath);
      valid = claimedOwner?.ownerGeneration === expectedGeneration;
    }
    return valid;
  } finally {
    if (!valid) {
      await claim.release();
    }
  }
}

async function lstatIfPresent(filePath: string): Promise<Stats | undefined> {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function unlinkIfPresent(filePath: string): Promise<void> {
  await fs.unlink(filePath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  });
}

export async function readQueueOwnerRecord(
  sessionId: string,
): Promise<QueueOwnerRecord | undefined> {
  return await readQueueOwnerRecordAtPath(queueLockFilePath(sessionId));
}

async function readQueueOwnerRecordAtPath(lockPath: string): Promise<QueueOwnerRecord | undefined> {
  try {
    const payload = await fs.readFile(lockPath, "utf8");
    const parsed = parseQueueOwnerRecord(JSON.parse(payload));
    return parsed ?? undefined;
  } catch {
    return undefined;
  }
}

export async function terminateProcess(pid: number): Promise<boolean> {
  if (!isProcessAlive(pid)) {
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

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return false;
  }

  await waitForProcessExit(pid, PROCESS_SIGKILL_GRACE_MS);
  return true;
}

export async function ensureOwnerIsUsable(
  sessionId: string,
  owner: QueueOwnerRecord,
): Promise<boolean> {
  const alive = isProcessAlive(owner.pid);
  const stale = isQueueOwnerHeartbeatStale(owner);
  if (alive && !stale) {
    return true;
  }

  await retireStaleQueueOwner(sessionId, owner);
  return false;
}

export async function readQueueOwnerStatus(
  sessionId: string,
): Promise<QueueOwnerStatus | undefined> {
  const owner = await readQueueOwnerRecord(sessionId);
  if (!owner) {
    return undefined;
  }

  const alive = await ensureOwnerIsUsable(sessionId, owner);
  if (!alive) {
    return undefined;
  }

  return {
    pid: owner.pid,
    socketPath: owner.socketPath,
    heartbeatAt: owner.heartbeatAt,
    ownerGeneration: owner.ownerGeneration,
    queueDepth: owner.queueDepth,
    alive,
    stale: isQueueOwnerHeartbeatStale(owner),
  };
}

export async function tryAcquireQueueOwnerLease(
  sessionId: string,
  mcpConfigOrNowIsoFactory?:
    | string
    | {
        path?: string;
        fingerprint?: string;
      }
    | (() => string),
  nowIsoFactory: () => string = nowIso,
): Promise<QueueOwnerLease | undefined> {
  const { mcpConfigPath, clock } = resolveLeaseArguments(mcpConfigOrNowIsoFactory, nowIsoFactory);
  const mcpConfigFingerprint = readMcpConfigFingerprint(mcpConfigOrNowIsoFactory);
  const mcpConfigMetadata = createMcpConfigMetadata(mcpConfigPath, mcpConfigFingerprint);
  await ensureQueueDir();
  const lockPath = queueLockFilePath(sessionId);
  const socketPath = queueSocketPath(sessionId);
  let createdAt = clock();
  const ownerGeneration = createOwnerGeneration();
  const buildPayload = () =>
    JSON.stringify(
      {
        pid: process.pid,
        sessionId,
        socketPath,
        createdAt,
        heartbeatAt: createdAt,
        ownerGeneration,
        queueDepth: 0,
        ...mcpConfigMetadata,
      },
      null,
      2,
    );
  let payload = buildPayload();

  let acquired = false;
  try {
    await writeQueueOwnerFileAtomically(lockPath, `${payload}\n`, "create");
    acquired = true;
  } catch (error) {
    if (!(await handleLeaseCollision(sessionId, error))) {
      return undefined;
    }
  }
  if (!acquired) {
    createdAt = clock();
    payload = buildPayload();
    try {
      await writeQueueOwnerFileAtomically(lockPath, `${payload}\n`, "create");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return undefined;
      }
      throw error;
    }
  }
  await removeSocketFile(socketPath).catch(() => {
    // best-effort stale socket cleanup after ownership is acquired
  });
  const lease = {
    sessionId,
    lockPath,
    socketPath,
    createdAt,
    ownerGeneration,
    ...mcpConfigMetadata,
  };
  queueOwnerLeaseStates.set(lease, {
    pendingRefresh: Promise.resolve(),
    released: false,
  });
  return lease;
}

function readMcpConfigFingerprint(
  mcpConfigOrNowIsoFactory:
    | string
    | {
        path?: string;
        fingerprint?: string;
      }
    | (() => string)
    | undefined,
): string | undefined {
  return typeof mcpConfigOrNowIsoFactory === "object"
    ? mcpConfigOrNowIsoFactory?.fingerprint
    : undefined;
}

function createMcpConfigMetadata(
  mcpConfigPath: string | undefined,
  mcpConfigFingerprint: string | undefined,
): { mcpConfigPath?: string; mcpConfigFingerprint?: string } {
  return {
    ...(mcpConfigPath ? { mcpConfigPath } : {}),
    ...(mcpConfigFingerprint ? { mcpConfigFingerprint } : {}),
  };
}

async function handleLeaseCollision(sessionId: string, error: unknown): Promise<boolean> {
  if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
    throw error;
  }

  const owner = await readQueueOwnerRecord(sessionId);
  if (!owner) {
    const lockPath = queueLockFilePath(sessionId);
    const staleLockStat = await staleMalformedQueueOwnerLockStat(lockPath);
    if (staleLockStat) {
      return await cleanupStaleQueueOwner(sessionId, owner, staleLockStat);
    }
    return false;
  }

  if (!isProcessAlive(owner.pid) || isQueueOwnerHeartbeatStale(owner)) {
    return await retireStaleQueueOwner(sessionId, owner);
  }
  return false;
}

function resolveLeaseArguments(
  mcpConfigOrNowIsoFactory:
    | string
    | {
        path?: string;
        fingerprint?: string;
      }
    | (() => string)
    | undefined,
  nowIsoFactory: () => string,
): { mcpConfigPath: string | undefined; clock: () => string } {
  if (typeof mcpConfigOrNowIsoFactory === "string") {
    return { mcpConfigPath: mcpConfigOrNowIsoFactory, clock: nowIsoFactory };
  }
  if (typeof mcpConfigOrNowIsoFactory === "function") {
    return { mcpConfigPath: undefined, clock: mcpConfigOrNowIsoFactory };
  }
  if (mcpConfigOrNowIsoFactory) {
    return { mcpConfigPath: mcpConfigOrNowIsoFactory.path, clock: nowIsoFactory };
  }
  return { mcpConfigPath: undefined, clock: nowIsoFactory };
}

export async function refreshQueueOwnerLease(
  lease: QueueOwnerLease,
  options: {
    queueDepth: number;
  },
  nowIsoFactory: () => string = nowIso,
): Promise<void> {
  const state = queueOwnerLeaseState(lease);
  if (state.released) {
    return;
  }
  const refresh = state.pendingRefresh.then(async () => {
    if (state.released) {
      return;
    }
    const claim = await claimQueueOwnerLock(lease.lockPath, lease.ownerGeneration);
    if (!claim) {
      return;
    }
    const payload = JSON.stringify(
      {
        pid: process.pid,
        sessionId: lease.sessionId,
        socketPath: lease.socketPath,
        createdAt: lease.createdAt,
        heartbeatAt: nowIsoFactory(),
        ownerGeneration: lease.ownerGeneration,
        queueDepth: Math.max(0, Math.round(options.queueDepth)),
        ...(lease.mcpConfigPath ? { mcpConfigPath: lease.mcpConfigPath } : {}),
        ...(lease.mcpConfigFingerprint ? { mcpConfigFingerprint: lease.mcpConfigFingerprint } : {}),
      },
      null,
      2,
    );
    try {
      if (!(await claim.isHeld())) {
        return;
      }
      await writeQueueOwnerFileAtomically(lease.lockPath, `${payload}\n`, "replace");
    } finally {
      await claim.release();
    }
  });
  state.pendingRefresh = refresh.catch(() => {
    // Keep the serialization chain usable after a best-effort refresh failure.
  });
  await refresh;
}

export async function releaseQueueOwnerLease(lease: QueueOwnerLease): Promise<void> {
  const state = queueOwnerLeaseState(lease);
  if (!state.releasePromise) {
    state.released = true;
    state.releasePromise = (async () => {
      await state.pendingRefresh;
      const claim = await claimQueueOwnerLock(lease.lockPath, lease.ownerGeneration);
      if (!claim) {
        return;
      }
      try {
        if (!(await claim.isHeld())) {
          return;
        }
        await removeSocketFile(lease.socketPath).catch(() => {
          // ignore best-effort cleanup failures
        });
        if (!(await claim.isHeld())) {
          return;
        }
        await unlinkIfPresent(lease.lockPath);
      } finally {
        await claim.release();
      }
    })();
  }
  await state.releasePromise;
}

function queueOwnerLeaseState(lease: QueueOwnerLease): QueueOwnerLeaseState {
  let state = queueOwnerLeaseStates.get(lease);
  if (!state) {
    state = {
      pendingRefresh: Promise.resolve(),
      released: false,
    };
    queueOwnerLeaseStates.set(lease, state);
  }
  return state;
}

export async function terminateQueueOwnerForSession(sessionId: string): Promise<void> {
  const owner = await readQueueOwnerRecord(sessionId);
  if (!owner) {
    return;
  }

  if (!(await cleanupStaleQueueOwner(sessionId, owner))) {
    throw new Error(`Queue owner cleanup is busy for session ${sessionId}; retry the operation`);
  }
}

export async function waitMs(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
