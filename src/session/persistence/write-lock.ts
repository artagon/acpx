import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { readProcessIdentity } from "../../acp/process-tree.js";
import { isProcessAlive } from "../../process-liveness.js";

const SESSION_WRITE_LOCK_FILE = ".write.lock";
const SESSION_WRITE_LOCK_WAIT_MS = 15_000;
const SESSION_WRITE_LOCK_POLL_MS = 10;
const SESSION_WRITE_LOCK_UNVERIFIED_STALE_MS = 120_000;

type SessionWriteLockRecord = {
  lockId: string;
  pid: number;
  processIdentity?: string;
  createdAt: string;
};

type SessionWriteLockLease = {
  lockPath: string;
  lockId: string;
};

const heldSessionWriteLocks = new AsyncLocalStorage<ReadonlySet<string>>();
let currentProcessIdentityPromise: Promise<string | undefined> | undefined;

export async function withSessionWriteLock<T>(
  sessionDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  const resolvedSessionDir = path.resolve(sessionDir);
  await fs.mkdir(resolvedSessionDir, { recursive: true });
  const canonicalSessionDir = await fs.realpath(resolvedSessionDir);
  const lockPath = path.join(canonicalSessionDir, SESSION_WRITE_LOCK_FILE);
  const heldLocks = heldSessionWriteLocks.getStore();
  if (heldLocks?.has(lockPath)) {
    return await operation();
  }

  const lease = await acquireSessionWriteLock(lockPath);
  const nestedLocks = new Set(heldLocks);
  nestedLocks.add(lockPath);
  try {
    return await heldSessionWriteLocks.run(nestedLocks, operation);
  } finally {
    await releaseSessionWriteLock(lease);
  }
}

async function acquireSessionWriteLock(lockPath: string): Promise<SessionWriteLockLease> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const lockRecord = await createSessionWriteLockRecord();
  const deadline = Date.now() + SESSION_WRITE_LOCK_WAIT_MS;

  for (;;) {
    if (await tryCreateSessionWriteLock(lockPath, lockRecord)) {
      return { lockPath, lockId: lockRecord.lockId };
    }
    if (await recoverStaleSessionWriteLock(lockPath)) {
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out acquiring session persistence lock: ${lockPath}`);
    }
    await waitMs(SESSION_WRITE_LOCK_POLL_MS);
  }
}

async function createSessionWriteLockRecord(): Promise<SessionWriteLockRecord> {
  currentProcessIdentityPromise ??= readProcessIdentity(process.pid);
  const processIdentity = await currentProcessIdentityPromise;
  return {
    lockId: randomUUID(),
    pid: process.pid,
    ...(processIdentity ? { processIdentity } : {}),
    createdAt: new Date().toISOString(),
  };
}

async function tryCreateSessionWriteLock(
  lockPath: string,
  lockRecord: SessionWriteLockRecord,
): Promise<boolean> {
  try {
    await fs.writeFile(lockPath, `${JSON.stringify(lockRecord)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw error;
  }
}

async function recoverStaleSessionWriteLock(lockPath: string): Promise<boolean> {
  const observedStat = await lstatIfPresent(lockPath);
  if (!observedStat || !(await sessionWriteLockIsStale(lockPath, observedStat))) {
    return false;
  }

  const quarantinePath = `${lockPath}.reap-${process.pid}-${randomUUID()}`;
  try {
    await fs.rename(lockPath, quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return true;
    }
    throw error;
  }

  const movedStat = await lstatIfPresent(quarantinePath);
  if (!movedStat || !sameFileIdentity(observedStat, movedStat)) {
    await restoreDisplacedSessionWriteLock(quarantinePath, lockPath);
    return false;
  }
  if (!(await sessionWriteLockIsStale(quarantinePath, movedStat))) {
    await restoreDisplacedSessionWriteLock(quarantinePath, lockPath);
    return false;
  }
  await unlinkIfPresent(quarantinePath);
  return true;
}

export async function sessionWriteLockIsStale(lockPath: string, stat: Stats): Promise<boolean> {
  const record = await readSessionWriteLockRecord(lockPath);
  if (!record) {
    return lockAgeMs(stat) > SESSION_WRITE_LOCK_UNVERIFIED_STALE_MS;
  }
  if (!sessionWriterIsAlive(record.pid)) {
    return true;
  }
  if (!record.processIdentity) {
    return false;
  }
  const currentIdentity = await readProcessIdentity(record.pid);
  return currentIdentity ? currentIdentity !== record.processIdentity : false;
}

function sessionWriterIsAlive(pid: number): boolean {
  return pid === process.pid || isProcessAlive(pid);
}

function lockAgeMs(stat: Stats): number {
  return Date.now() - stat.mtimeMs;
}

async function restoreDisplacedSessionWriteLock(
  quarantinePath: string,
  lockPath: string,
): Promise<void> {
  try {
    await fs.link(quarantinePath, lockPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return;
    }
    if (code !== "EEXIST") {
      throw error;
    }
  }
  await unlinkIfPresent(quarantinePath);
}

async function releaseSessionWriteLock(lease: SessionWriteLockLease): Promise<void> {
  const current = await readSessionWriteLockRecord(lease.lockPath);
  if (current?.lockId === lease.lockId) {
    await unlinkIfPresent(lease.lockPath);
  }
}

async function readSessionWriteLockRecord(
  lockPath: string,
): Promise<SessionWriteLockRecord | undefined> {
  try {
    return parseSessionWriteLockRecord(JSON.parse(await fs.readFile(lockPath, "utf8")));
  } catch {
    return undefined;
  }
}

function parseSessionWriteLockRecord(value: unknown): SessionWriteLockRecord | undefined {
  if (!isSessionWriteLockRecord(value)) {
    return undefined;
  }
  return {
    lockId: value.lockId,
    pid: value.pid,
    ...(value.processIdentity ? { processIdentity: value.processIdentity } : {}),
    createdAt: value.createdAt,
  };
}

function isSessionWriteLockRecord(value: unknown): value is SessionWriteLockRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    isNonEmptyString(record.lockId) &&
    isPositiveInteger(record.pid) &&
    isOptionalNonEmptyString(record.processIdentity) &&
    typeof record.createdAt === "string"
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function isOptionalNonEmptyString(value: unknown): value is string | undefined {
  return value === undefined || isNonEmptyString(value);
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

async function waitMs(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
