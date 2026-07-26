import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Cache for capability probes that shell out to an agent CLI.
 *
 * Some adapters can only be interrogated by running them (e.g. `copilot --help`
 * to learn whether `--acp` exists — measured at ~380ms on every launch). The
 * answer is a property of the binary, not of the invocation, so it is cached
 * against a fingerprint of that binary and recomputed only when the binary
 * changes.
 *
 * The fingerprint is a hash of realpath + size + mtime rather than of the file
 * contents: agent CLIs are tens of megabytes and hashing them on every launch
 * would cost more than the probe it replaces. Any upgrade, reinstall, or
 * rebuild moves at least one of those three.
 *
 * Every failure path degrades to "cache miss". A capability cache must never be
 * able to break a launch.
 */

type CacheEntry = {
  fingerprint: string;
  value: boolean;
  recordedAt: string;
};

type CacheFile = Record<string, CacheEntry>;

const CACHE_VERSION = "v1";

function cacheFilePath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".acpx", "cache", `cli-capabilities.${CACHE_VERSION}.json`);
}

/**
 * Agent commands are usually bare names resolved through PATH at spawn time, so
 * resolve them the same way before fingerprinting. Returns the input unchanged
 * when it already contains a separator.
 */
async function resolveExecutablePath(command: string): Promise<string | undefined> {
  if (command.includes(path.sep) || command.includes("/")) {
    return command;
  }
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const candidate = path.join(entry, command);
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Not here; keep looking.
    }
  }
  return undefined;
}

/**
 * Identifies the exact binary a capability answer belongs to. Returns undefined
 * when the path cannot be resolved or stat'd, which forces a live probe.
 */
export async function fingerprintExecutable(binaryPath: string): Promise<string | undefined> {
  try {
    const resolved = await resolveExecutablePath(binaryPath);
    if (!resolved) {
      return undefined;
    }
    const realPath = await fs.realpath(resolved);
    const stats = await fs.stat(realPath);
    return createHash("sha256")
      .update(`${realPath}\0${stats.size}\0${stats.mtimeMs}`)
      .digest("hex")
      .slice(0, 32);
  } catch {
    return undefined;
  }
}

async function readCacheFile(homeDir?: string): Promise<CacheFile> {
  try {
    const raw = await fs.readFile(cacheFilePath(homeDir), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as CacheFile)
      : {};
  } catch {
    return {};
  }
}

/**
 * Pure lookup: given a cache snapshot, what does it say about this key?
 * Separated from I/O so the matching rule is testable without a filesystem.
 */
export function lookupCapability(
  cache: CacheFile,
  key: string,
  fingerprint: string | undefined,
): boolean | undefined {
  if (!fingerprint) {
    return undefined;
  }
  const entry = cache[key];
  return entry?.fingerprint === fingerprint ? entry.value : undefined;
}

/** Pure update: returns a new snapshot, never mutates the input. */
export function withCapability(cache: CacheFile, key: string, entry: CacheEntry): CacheFile {
  return { ...cache, [key]: entry };
}

export async function readCachedCapability(
  key: string,
  fingerprint: string | undefined,
  homeDir?: string,
): Promise<boolean | undefined> {
  if (!fingerprint) {
    return undefined;
  }
  return lookupCapability(await readCacheFile(homeDir), key, fingerprint);
}

export async function writeCachedCapability(
  key: string,
  fingerprint: string | undefined,
  value: boolean,
  homeDir?: string,
): Promise<void> {
  if (!fingerprint) {
    return;
  }
  try {
    const filePath = cacheFilePath(homeDir);
    const cache = withCapability(await readCacheFile(homeDir), key, {
      fingerprint,
      value,
      recordedAt: new Date().toISOString(),
    });
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    // Write-then-rename so a concurrent reader never sees a partial file.
    const tempPath = `${filePath}.${process.pid}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
    await fs.rename(tempPath, filePath);
  } catch {
    // Best effort: an unwritable cache must not fail the launch.
  }
}
