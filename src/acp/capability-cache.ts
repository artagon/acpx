import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveWindowsCommand } from "../spawn-command-options.js";

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
export type ExecutableResolutionOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
};

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    const stats = await fs.stat(candidate);
    if (!stats.isFile()) {
      return false;
    }
    await fs.access(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function firstExecutableCandidate(
  pathEntries: readonly string[],
  candidateNames: readonly string[],
): Promise<string | undefined> {
  for (const entry of pathEntries) {
    for (const candidateName of candidateNames) {
      const candidate = path.join(entry, candidateName);
      if (await isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

export async function resolveExecutablePath(
  command: string,
  options: ExecutableResolutionOptions = {},
): Promise<string | undefined> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  if (platform === "win32") {
    return resolveWindowsCommand(command, env, cwd, false);
  }
  return await resolvePosixExecutablePath(command, env, cwd);
}

async function resolvePosixExecutablePath(
  command: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<string | undefined> {
  if (command.includes(path.sep) || command.includes("/")) {
    return path.resolve(cwd, command);
  }
  const pathEntries = (env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((entry) => path.resolve(cwd, entry));
  return await firstExecutableCandidate(pathEntries, [command]);
}

/**
 * Identifies the exact binary a capability answer belongs to. Returns undefined
 * when the path cannot be resolved or stat'd, which forces a live probe.
 */
export async function fingerprintExecutable(
  binaryPath: string,
  options: ExecutableResolutionOptions = {},
): Promise<string | undefined> {
  try {
    const platform = options.platform ?? process.platform;
    if (platform === "win32") {
      // Windows launchers may be stable, cwd-sensitive shims whose selected
      // target cannot be inferred reliably from the launcher file itself.
      return undefined;
    }
    const resolved = await resolveExecutablePath(binaryPath, options);
    if (!resolved) {
      return undefined;
    }
    const realPath = await fs.realpath(resolved);
    const stats = await fs.stat(realPath);
    if (!stats.isFile()) {
      return undefined;
    }
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
