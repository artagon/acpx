import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readProcessIdentity } from "../src/acp/process-tree.js";
import {
  claimQueueOwnerLock,
  ensureOwnerIsUsable,
  isProcessAlive,
  type QueueOwnerLease,
  readQueueOwnerRecord,
  readQueueOwnerStatus,
  refreshQueueOwnerLease,
  releaseQueueOwnerLease,
  terminateProcess,
  terminateQueueOwnerForSession,
  tryAcquireQueueOwnerLease,
} from "../src/cli/queue/lease-store.js";
import { queueBaseDir, queueLockFilePath, queueSocketBaseDir } from "../src/cli/queue/paths.js";
import {
  queuePaths,
  startKeeperProcess,
  stopProcess,
  withTempHome,
  writeQueueOwnerLock,
} from "./queue-test-helpers.js";

test("readQueueOwnerRecord returns undefined for missing and malformed lock files", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "missing-record";
    assert.equal(await readQueueOwnerRecord(sessionId), undefined);

    const lockPath = queueLockFilePath(sessionId, homeDir);
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, "{not-json\n", "utf8");
    assert.equal(await readQueueOwnerRecord(sessionId), undefined);

    await fs.writeFile(lockPath, `${JSON.stringify({ pid: "bad" })}\n`, "utf8");
    assert.equal(await readQueueOwnerRecord(sessionId), undefined);
  });
});

test("tryAcquireQueueOwnerLease creates a lease that can be refreshed and released", async () => {
  await withTempHome(async () => {
    const lease = await tryAcquireQueueOwnerLease("lease-create");
    assert(lease);
    assert.equal(lease.sessionId, "lease-create");
    const expectedProcessIdentity = await readProcessIdentity(process.pid);
    assert.equal(lease.processIdentity, expectedProcessIdentity);

    await refreshQueueOwnerLease(
      lease,
      {
        queueDepth: 1.7,
      },
      () => "2026-03-26T00:00:00.000Z",
    );

    const record = await readQueueOwnerRecord("lease-create");
    assert(record);
    assert.equal(record.processIdentity, expectedProcessIdentity);
    assert.equal(record.queueDepth, 2);
    assert.equal(record.heartbeatAt, "2026-03-26T00:00:00.000Z");

    await releaseQueueOwnerLease(lease);
    assert.equal(await readQueueOwnerRecord("lease-create"), undefined);
  });
});

test("tryAcquireQueueOwnerLease persists MCP config path metadata", async () => {
  await withTempHome(async () => {
    const lease = await tryAcquireQueueOwnerLease("lease-mcp-config", {
      path: "/tmp/job-mcp.json",
      fingerprint: "fingerprint-v1",
    });
    assert(lease);
    assert.equal(lease.mcpConfigPath, "/tmp/job-mcp.json");
    assert.equal(lease.mcpConfigFingerprint, "fingerprint-v1");

    const record = await readQueueOwnerRecord("lease-mcp-config");
    assert(record);
    assert.equal(record.mcpConfigPath, "/tmp/job-mcp.json");
    assert.equal(record.mcpConfigFingerprint, "fingerprint-v1");

    await refreshQueueOwnerLease(lease, { queueDepth: 2 });
    const refreshed = await readQueueOwnerRecord("lease-mcp-config");
    assert(refreshed);
    assert.equal(refreshed.mcpConfigPath, "/tmp/job-mcp.json");
    assert.equal(refreshed.mcpConfigFingerprint, "fingerprint-v1");

    await releaseQueueOwnerLease(lease);
  });
});

test("tryAcquireQueueOwnerLease preserves the legacy clock callback argument", async () => {
  await withTempHome(async () => {
    const lease = await tryAcquireQueueOwnerLease(
      "lease-clock-callback",
      () => "2026-03-26T00:00:00.000Z",
    );
    assert(lease);
    assert.equal(lease.createdAt, "2026-03-26T00:00:00.000Z");
    await releaseQueueOwnerLease(lease);
  });
});

test("tryAcquireQueueOwnerLease assigns collision-resistant owner generations", async () => {
  await withTempHome(async () => {
    const originalDateNow = Date.now;
    const originalMathRandom = Math.random;
    Date.now = () => 1_777_072_400_000;
    Math.random = () => 0;

    try {
      const first = await tryAcquireQueueOwnerLease("lease-generation-a");
      const second = await tryAcquireQueueOwnerLease("lease-generation-b");
      assert(first);
      assert(second);
      assert.notEqual(first.ownerGeneration, second.ownerGeneration);
      assert(Number.isSafeInteger(first.ownerGeneration));
      assert(Number.isSafeInteger(second.ownerGeneration));
      assert(first.ownerGeneration > 0);
      assert(second.ownerGeneration > 0);
      await releaseQueueOwnerLease(first);
      await releaseQueueOwnerLease(second);
    } finally {
      Date.now = originalDateNow;
      Math.random = originalMathRandom;
    }
  });
});

test("tryAcquireQueueOwnerLease tightens queue directory permissions", async () => {
  if (process.platform === "win32") {
    return;
  }

  await withTempHome(async (homeDir) => {
    const baseDir = queueBaseDir(homeDir);
    const socketDir = queueSocketBaseDir(homeDir);
    assert(socketDir);

    await fs.mkdir(baseDir, { recursive: true, mode: 0o777 });
    await fs.chmod(baseDir, 0o777);
    await fs.mkdir(socketDir, { recursive: true, mode: 0o777 });
    await fs.chmod(socketDir, 0o777);

    const lease = await tryAcquireQueueOwnerLease("lease-permissions");
    assert(lease);

    try {
      const baseMode = (await fs.stat(baseDir)).mode & 0o777;
      const socketMode = (await fs.stat(socketDir)).mode & 0o777;
      assert.equal(baseMode, 0o700);
      assert.equal(socketMode, 0o700);
    } finally {
      await releaseQueueOwnerLease(lease);
      await fs.rm(socketDir, { recursive: true, force: true });
    }
  });
});

test("tryAcquireQueueOwnerLease replaces a stale dead owner in the same attempt", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "stale-dead-owner";
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);

    await writeQueueOwnerLock({
      lockPath,
      pid: 999_999,
      sessionId,
      socketPath,
      heartbeatAt: "2000-01-01T00:00:00.000Z",
    });

    const lease = await tryAcquireQueueOwnerLease(sessionId);
    assert(lease);
    assert.equal((await readQueueOwnerRecord(sessionId))?.ownerGeneration, lease.ownerGeneration);
    await releaseQueueOwnerLease(lease);
  });
});

test("retry acquisition timestamps the replacement after stale-owner cleanup", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "stale-owner-fresh-replacement-time";
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);
    await writeQueueOwnerLock({
      lockPath,
      pid: 999_999,
      sessionId,
      socketPath,
      heartbeatAt: "2000-01-01T00:00:00.000Z",
    });
    const timestamps = ["2026-07-29T12:00:00.000Z", "2026-07-29T12:00:07.000Z"];
    let clockIndex = 0;

    const lease = await tryAcquireQueueOwnerLease(
      sessionId,
      () => timestamps[clockIndex++] ?? timestamps[1],
    );
    assert(lease);
    assert.equal(lease.createdAt, timestamps[1]);
    const owner = await readQueueOwnerRecord(sessionId);
    assert(owner);
    assert.equal(owner.createdAt, timestamps[1]);
    assert.equal(owner.heartbeatAt, timestamps[1]);
    await releaseQueueOwnerLease(lease);
  });
});

test("tryAcquireQueueOwnerLease preserves a fresh malformed lock during collision", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "fresh-malformed-owner";
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);
    const malformedPayload = "{incomplete";
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, malformedPayload, "utf8");
    if (process.platform !== "win32") {
      await fs.mkdir(path.dirname(socketPath), { recursive: true });
      await fs.writeFile(socketPath, "live-socket-placeholder", "utf8");
    }

    assert.equal(await tryAcquireQueueOwnerLease(sessionId), undefined);
    assert.equal(await fs.readFile(lockPath, "utf8"), malformedPayload);
    if (process.platform !== "win32") {
      assert.equal(await fs.readFile(socketPath, "utf8"), "live-socket-placeholder");
    }

    await fs.rm(lockPath, { force: true });
    if (process.platform !== "win32") {
      await fs.rm(socketPath, { force: true });
    }
  });
});

test("tryAcquireQueueOwnerLease removes a malformed lock only after it is stale", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "stale-malformed-owner";
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, "{incomplete", "utf8");
    await fs.utimes(lockPath, new Date(0), new Date(0));
    if (process.platform !== "win32") {
      await fs.mkdir(path.dirname(socketPath), { recursive: true });
      await fs.writeFile(socketPath, "stale-socket-placeholder", "utf8");
    }

    const lease = await tryAcquireQueueOwnerLease(sessionId);
    assert(lease);
    assert.equal((await readQueueOwnerRecord(sessionId))?.ownerGeneration, lease.ownerGeneration);
    if (process.platform !== "win32") {
      await assert.rejects(fs.access(socketPath));
    }
    await releaseQueueOwnerLease(lease);
  });
});

test("stale cleanup never trusts a persisted socket path outside the queue directory", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "untrusted-socket-path";
    const { lockPath } = queuePaths(homeDir, sessionId);
    const unrelatedPath = path.join(homeDir, "unrelated-user-file");
    await fs.writeFile(unrelatedPath, "preserve me\n", "utf8");
    await writeQueueOwnerLock({
      lockPath,
      pid: 999_999,
      sessionId,
      socketPath: unrelatedPath,
      heartbeatAt: "2000-01-01T00:00:00.000Z",
    });
    const staleTime = new Date("2000-01-01T00:00:00.000Z");
    await fs.utimes(lockPath, staleTime, staleTime);

    const lease = await tryAcquireQueueOwnerLease(sessionId);

    assert(lease);
    assert.equal(await fs.readFile(unrelatedPath, "utf8"), "preserve me\n");
    await releaseQueueOwnerLease(lease);
  });
});

test(
  "tryAcquireQueueOwnerLease ages out a stale dangling symlink lock",
  { skip: process.platform === "win32" },
  async () => {
    await withTempHome(async (homeDir) => {
      const sessionId = "stale-dangling-symlink-owner";
      const { lockPath } = queuePaths(homeDir, sessionId);
      await fs.mkdir(path.dirname(lockPath), { recursive: true });
      await fs.symlink("missing-owner-record", lockPath);
      await fs.lutimes(lockPath, new Date(0), new Date(0));

      const lease = await tryAcquireQueueOwnerLease(sessionId);
      assert(lease);
      assert.equal((await readQueueOwnerRecord(sessionId))?.ownerGeneration, lease.ownerGeneration);
      await releaseQueueOwnerLease(lease);
    });
  },
);

test("refreshQueueOwnerLease never exposes a partial record to concurrent readers", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "atomic-refresh";
    const lease = await tryAcquireQueueOwnerLease(sessionId);
    assert(lease);

    try {
      const writers = Array.from({ length: 200 }, async (_, index) => {
        await refreshQueueOwnerLease(lease, { queueDepth: index % 5 });
      });
      const observations = await Promise.all(
        Array.from({ length: 200 }, async () => await readQueueOwnerRecord(sessionId)),
      );
      await Promise.all(writers);
      assert.equal(
        observations.every((record) => record !== undefined),
        true,
      );

      const files = await fs.readdir(path.dirname(queueLockFilePath(sessionId, homeDir)));
      assert.deepEqual(files, [path.basename(queueLockFilePath(sessionId, homeDir))]);
    } finally {
      await releaseQueueOwnerLease(lease);
    }
  });
});

test("lock claims serialize cross-process refresh and release mutations", async () => {
  await withTempHome(async () => {
    const sessionId = "claimed-owner-mutation";
    const lease = await tryAcquireQueueOwnerLease(sessionId);
    assert(lease);
    const claim = await claimQueueOwnerLock(lease.lockPath, lease.ownerGeneration);
    assert(claim);
    assert.equal(await claim.isHeld(), true);

    await refreshQueueOwnerLease(lease, { queueDepth: 7 });
    assert.equal(await claim.isHeld(), true);
    await assert.rejects(releaseQueueOwnerLease(lease), /lease release is busy.*retry cleanup/);
    assert.equal(await claim.isHeld(), true);
    const blockedRecord = await readQueueOwnerRecord(sessionId);
    assert(blockedRecord);
    assert.equal(blockedRecord.queueDepth, 0);

    await claim.release();
    await refreshQueueOwnerLease(lease, { queueDepth: 7 });
    const refreshedRecord = await readQueueOwnerRecord(sessionId);
    assert(refreshedRecord);
    assert.equal(refreshedRecord.queueDepth, 7);
    await releaseQueueOwnerLease(lease);
  });
});

test("lock claims recover after a claimant crashes", async () => {
  await withTempHome(async () => {
    const sessionId = "crashed-lock-claimant";
    const lease = await tryAcquireQueueOwnerLease(sessionId);
    assert(lease);
    const modulePath = fileURLToPath(new URL("../src/cli/queue/lease-store.js", import.meta.url));
    const script = `
      const { claimQueueOwnerLock } = await import(${JSON.stringify(modulePath)});
      const claim = await claimQueueOwnerLock(
        ${JSON.stringify(lease.lockPath)},
        ${lease.ownerGeneration},
      );
      if (!claim) process.exit(2);
      process.stdout.write("claimed\\n");
      setInterval(() => {}, 60_000);
    `;
    const claimant = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      { stdio: ["ignore", "pipe", "inherit"] },
    );

    try {
      assert(claimant.stdout);
      const output = await waitForChildOutput(claimant);
      assert.equal(output.toString(), "claimed\n");
      assert.equal(await claimQueueOwnerLock(lease.lockPath, lease.ownerGeneration), undefined);

      claimant.kill("SIGKILL");
      await once(claimant, "close");

      const recovered = await claimQueueOwnerLock(lease.lockPath, lease.ownerGeneration);
      assert(recovered);
      await recovered.release();
      await releaseQueueOwnerLease(lease);
    } finally {
      if (claimant.exitCode == null && claimant.signalCode == null) {
        claimant.kill("SIGKILL");
      }
    }
  });
});

test("owner shutdown defers lease removal to a live external cleanup claimant", async () => {
  await withTempHome(async () => {
    const sessionId = "external-cleaner-owner-shutdown";
    const modulePath = fileURLToPath(new URL("../src/cli/queue/lease-store.js", import.meta.url));
    const script = `
      const { releaseQueueOwnerLease, tryAcquireQueueOwnerLease } = await import(${JSON.stringify(modulePath)});
      const lease = await tryAcquireQueueOwnerLease(${JSON.stringify(sessionId)});
      if (!lease) process.exit(2);
      process.stdout.write(JSON.stringify(lease) + "\\n");
      process.on("SIGTERM", () => {
        void releaseQueueOwnerLease(lease).then(
          () => process.exit(0),
          () => process.exit(1),
        );
      });
      setInterval(() => {}, 60_000);
    `;
    const owner = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      { stdio: ["ignore", "pipe", "inherit"] },
    );

    try {
      const lease = JSON.parse((await waitForChildOutput(owner)).toString()) as QueueOwnerLease;
      const claim = await claimQueueOwnerLock(lease.lockPath, lease.ownerGeneration);
      assert(claim);
      owner.kill("SIGTERM");
      const [code] = (await once(owner, "exit")) as [number | null, NodeJS.Signals | null];
      assert.equal(code, 0);
      await claim.release();
      await fs.rm(lease.lockPath, { force: true });
    } finally {
      if (owner.exitCode == null && owner.signalCode == null) {
        owner.kill("SIGKILL");
      }
    }
  });
});

test("explicit cleanup waits for an active lease claim", async () => {
  await withTempHome(async () => {
    const sessionId = "cleanup-claim-contention";
    const lease = await tryAcquireQueueOwnerLease(sessionId);
    assert(lease);
    const claim = await claimQueueOwnerLock(lease.lockPath, lease.ownerGeneration);
    assert(claim);

    const cleanup = terminateQueueOwnerForSession(sessionId);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    assert(await readQueueOwnerRecord(sessionId));
    await claim.release();
    await cleanup;

    assert.equal(await readQueueOwnerRecord(sessionId), undefined);
  });
});

test("lease release waits for an active same-generation claim", async () => {
  await withTempHome(async () => {
    const sessionId = "release-claim-contention";
    const lease = await tryAcquireQueueOwnerLease(sessionId);
    assert(lease);
    const claim = await claimQueueOwnerLock(lease.lockPath, lease.ownerGeneration);
    assert(claim);

    const release = releaseQueueOwnerLease(lease);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    assert(await readQueueOwnerRecord(sessionId));
    await claim.release();
    await release;

    assert.equal(await readQueueOwnerRecord(sessionId), undefined);
  });
});

test("explicit cleanup succeeds when a contended lease is concurrently removed", async () => {
  await withTempHome(async () => {
    const sessionId = "cleanup-concurrent-removal";
    const lease = await tryAcquireQueueOwnerLease(sessionId);
    assert(lease);
    const claim = await claimQueueOwnerLock(lease.lockPath, lease.ownerGeneration);
    assert(claim);

    const cleanup = terminateQueueOwnerForSession(sessionId);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    await fs.rm(lease.lockPath);
    await claim.release();

    await cleanup;
    assert.equal(await readQueueOwnerRecord(sessionId), undefined);
  });
});

test("explicit cleanup fails visibly after prolonged lease claim contention", async () => {
  await withTempHome(async () => {
    const sessionId = "cleanup-prolonged-claim-contention";
    const lease = await tryAcquireQueueOwnerLease(sessionId);
    assert(lease);
    const claim = await claimQueueOwnerLock(lease.lockPath, lease.ownerGeneration);
    assert(claim);

    await assert.rejects(
      terminateQueueOwnerForSession(sessionId),
      /cleanup is busy.*retry the operation/,
    );
    assert(await readQueueOwnerRecord(sessionId));

    await claim.release();
    await terminateQueueOwnerForSession(sessionId);
    assert.equal(await readQueueOwnerRecord(sessionId), undefined);
  });
});

async function waitForChildOutput(child: ReturnType<typeof spawn>): Promise<Buffer> {
  const stdout = child.stdout;
  assert(stdout);
  return await new Promise<Buffer>((resolve, reject) => {
    const cleanup = () => {
      stdout.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const onData = (chunk: Buffer) => {
      cleanup();
      resolve(chunk);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`claimant exited before readiness: code=${code} signal=${signal}`));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    stdout.once("data", onData);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

test("lock claims reject a replacement published after stale identity inspection", async () => {
  await withTempHome(async () => {
    const sessionId = "stale-identity-replacement";
    const lease = await tryAcquireQueueOwnerLease(sessionId);
    assert(lease);
    const oldStat = await fs.lstat(lease.lockPath);
    const oldPath = `${lease.lockPath}.old`;
    await fs.rename(lease.lockPath, oldPath);
    const successorGeneration = lease.ownerGeneration + 1;
    const successor = JSON.parse(await fs.readFile(oldPath, "utf8")) as Record<string, unknown>;
    successor.ownerGeneration = successorGeneration;
    await fs.writeFile(lease.lockPath, `${JSON.stringify(successor, null, 2)}\n`, "utf8");

    assert.equal(await claimQueueOwnerLock(lease.lockPath, undefined, oldStat), undefined);
    const record = await readQueueOwnerRecord(sessionId);
    assert(record);
    assert.equal(record.ownerGeneration, successorGeneration);

    await fs.rm(oldPath, { force: true });
    await fs.rm(lease.lockPath, { force: true });
  });
});

test("identity-less lock claims age out after claimant PID reuse cannot be excluded", async () => {
  await withTempHome(async () => {
    const sessionId = "identity-less-claim";
    const lease = await tryAcquireQueueOwnerLease(sessionId);
    assert(lease);
    const lockStat = await fs.lstat(lease.lockPath);
    const claimPath = `${lease.lockPath}.claim-${lockStat.dev}-${lockStat.ino}`;
    await fs.writeFile(
      claimPath,
      `${JSON.stringify({ claimId: "missing-identity", pid: process.pid })}\n`,
      "utf8",
    );
    const staleTime = new Date(Date.now() - 20_000);
    await fs.utimes(claimPath, staleTime, staleTime);

    const recovered = await claimQueueOwnerLock(lease.lockPath, lease.ownerGeneration);
    assert(recovered);
    await recovered.release();
    await releaseQueueOwnerLease(lease);
  });
});

test("restoring a displaced lock claim never overwrites a concurrent claim", async () => {
  await withTempHome(async () => {
    const sessionId = "displaced-claim-restore-race";
    const lease = await tryAcquireQueueOwnerLease(sessionId);
    assert(lease);
    const lockStat = await fs.lstat(lease.lockPath);
    const claimPath = `${lease.lockPath}.claim-${lockStat.dev}-${lockStat.ino}`;
    const displacedClaim = {
      claimId: "displaced-claim",
      pid: process.pid,
    };
    const concurrentClaim = {
      claimId: "concurrent-claim",
      pid: process.pid,
    };
    await fs.writeFile(claimPath, `${JSON.stringify(displacedClaim)}\n`, "utf8");
    const staleTime = new Date(Date.now() - 20_000);
    await fs.utimes(claimPath, staleTime, staleTime);

    const originalRename = fs.rename;
    let raceInjected = false;
    fs.rename = async (oldPath, newPath): Promise<void> => {
      await originalRename(oldPath, newPath);
      if (
        !raceInjected &&
        oldPath === claimPath &&
        String(newPath).startsWith(`${claimPath}.reap-`)
      ) {
        raceInjected = true;
        const refreshedTime = new Date();
        await fs.utimes(newPath, refreshedTime, refreshedTime);
        await fs.writeFile(claimPath, `${JSON.stringify(concurrentClaim)}\n`, {
          encoding: "utf8",
          flag: "wx",
        });
      }
    };

    try {
      assert.equal(await claimQueueOwnerLock(lease.lockPath, lease.ownerGeneration), undefined);
      assert.equal(raceInjected, true);
      const survivingClaim = JSON.parse(await fs.readFile(claimPath, "utf8")) as {
        claimId?: unknown;
      };
      assert.equal(survivingClaim.claimId, concurrentClaim.claimId);
      const claimFiles = await fs.readdir(path.dirname(claimPath));
      assert.equal(
        claimFiles.some((fileName) => fileName.startsWith(`${path.basename(claimPath)}.reap-`)),
        false,
      );
    } finally {
      fs.rename = originalRename;
      await fs.rm(claimPath, { force: true });
      await releaseQueueOwnerLease(lease);
    }
  });
});

test("a claim released while temporarily displaced is not restored as an orphan", async () => {
  await withTempHome(async () => {
    const sessionId = "displaced-claim-release-race";
    const lease = await tryAcquireQueueOwnerLease(sessionId);
    assert(lease);
    const lockStat = await fs.lstat(lease.lockPath);
    const claimPath = `${lease.lockPath}.claim-${lockStat.dev}-${lockStat.ino}`;
    await fs.writeFile(
      claimPath,
      `${JSON.stringify({ claimId: "stale-claim", pid: 999_999_999 })}\n`,
      "utf8",
    );

    const originalLink = fs.link;
    const originalRename = fs.rename;
    let concurrentClaim: Awaited<ReturnType<typeof claimQueueOwnerLock>>;
    let raceInjected = false;
    fs.rename = async (oldPath, newPath): Promise<void> => {
      if (
        !raceInjected &&
        oldPath === claimPath &&
        String(newPath).startsWith(`${claimPath}.reap-`)
      ) {
        raceInjected = true;
        await fs.unlink(claimPath);
        concurrentClaim = await claimQueueOwnerLock(lease.lockPath, lease.ownerGeneration);
        assert(concurrentClaim);
      }
      await originalRename(oldPath, newPath);
    };
    fs.link = async (existingPath, newPath): Promise<void> => {
      if (
        raceInjected &&
        concurrentClaim &&
        String(existingPath).startsWith(`${claimPath}.reap-`) &&
        newPath === claimPath
      ) {
        await concurrentClaim.release();
      }
      await originalLink(existingPath, newPath);
    };

    try {
      assert.equal(await claimQueueOwnerLock(lease.lockPath, lease.ownerGeneration), undefined);
      assert.equal(raceInjected, true);
      await assert.rejects(fs.access(claimPath));
    } finally {
      fs.rename = originalRename;
      fs.link = originalLink;
      await fs.rm(claimPath, { force: true });
      await releaseQueueOwnerLease(lease);
    }
  });
});

test("released owners cannot overwrite or remove a successor lease", async () => {
  await withTempHome(async () => {
    const sessionId = "released-owner-refresh";
    const releasedLease = await tryAcquireQueueOwnerLease(sessionId);
    assert(releasedLease);
    await releaseQueueOwnerLease(releasedLease);

    const successorLease = await tryAcquireQueueOwnerLease(sessionId);
    assert(successorLease);
    try {
      await refreshQueueOwnerLease(releasedLease, { queueDepth: 9 });
      await releaseQueueOwnerLease(releasedLease);

      const record = await readQueueOwnerRecord(sessionId);
      assert(record);
      assert.equal(record.ownerGeneration, successorLease.ownerGeneration);
      assert.equal(record.queueDepth, 0);
    } finally {
      await releaseQueueOwnerLease(successorLease);
    }
  });
});

test("readQueueOwnerStatus returns live owner details for a healthy owner", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "healthy-owner";
    const keeper = await startKeeperProcess();
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);

    try {
      const processIdentity = await readProcessIdentity(keeper.pid!);
      await writeQueueOwnerLock({
        lockPath,
        pid: keeper.pid,
        processIdentity,
        sessionId,
        socketPath,
        queueDepth: 3,
      });

      const status = await readQueueOwnerStatus(sessionId);
      assert(status);
      assert.equal(status.pid, keeper.pid);
      assert.equal(status.alive, true);
      assert.equal(status.stale, false);
      assert.equal(status.queueDepth, 3);
    } finally {
      stopProcess(keeper);
      await fs.rm(lockPath, { force: true });
      if (process.platform !== "win32") {
        await fs.rm(socketPath, { force: true });
      }
    }
  });
});

test("ensureOwnerIsUsable preserves stale live owners", async (t) => {
  await withTempHome(async (homeDir) => {
    const sessionId = "stale-live-owner";
    const keeper = await startKeeperProcess();
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);

    try {
      const processIdentity = await readProcessIdentity(keeper.pid!);
      if (!processIdentity) {
        t.skip("process identity unavailable in the managed environment");
        return;
      }
      await writeQueueOwnerLock({
        lockPath,
        pid: keeper.pid,
        processIdentity,
        sessionId,
        socketPath,
        heartbeatAt: "2000-01-01T00:00:00.000Z",
      });

      const owner = await readQueueOwnerRecord(sessionId);
      assert(owner);
      assert.equal(await ensureOwnerIsUsable(sessionId, owner), true);
      assert.equal((await readQueueOwnerRecord(sessionId))?.pid, keeper.pid);
      assert.equal(isProcessAlive(keeper.pid), true);
    } finally {
      stopProcess(keeper);
    }
  });
});

test("stale live owners remain usable while their lease refreshes", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "stale-owner-refreshed-before-claim";
    const keeper = await startKeeperProcess();
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);
    let claim: Awaited<ReturnType<typeof claimQueueOwnerLock>> | undefined;

    try {
      const processIdentity = await readProcessIdentity(keeper.pid!);
      await writeQueueOwnerLock({
        lockPath,
        pid: keeper.pid,
        processIdentity,
        sessionId,
        socketPath,
        heartbeatAt: "2000-01-01T00:00:00.000Z",
      });
      const staleOwner = await readQueueOwnerRecord(sessionId);
      assert(staleOwner);
      claim = await claimQueueOwnerLock(lockPath, staleOwner.ownerGeneration);
      assert(claim);

      const cleanup = ensureOwnerIsUsable(sessionId, staleOwner);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });

      const refreshedPath = `${lockPath}.refreshed`;
      await fs.writeFile(
        refreshedPath,
        `${JSON.stringify({ ...staleOwner, heartbeatAt: new Date().toISOString() })}\n`,
        "utf8",
      );
      await fs.rename(refreshedPath, lockPath);

      assert.equal(await cleanup, true);
      assert.equal(isProcessAlive(keeper.pid), true);
      assert.equal((await readQueueOwnerStatus(sessionId))?.alive, true);
    } finally {
      await claim?.release();
      stopProcess(keeper);
      await fs.rm(lockPath, { force: true });
      if (process.platform !== "win32") {
        await fs.rm(socketPath, { force: true });
      }
    }
  });
});

test("tryAcquireQueueOwnerLease fails closed for stale live owners", async (t) => {
  await withTempHome(async (homeDir) => {
    const sessionId = "stale-live-owner-acquire";
    const keeper = await startKeeperProcess();
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);

    try {
      const processIdentity = await readProcessIdentity(keeper.pid!);
      if (!processIdentity) {
        t.skip("process identity unavailable in the managed environment");
        return;
      }
      await writeQueueOwnerLock({
        lockPath,
        pid: keeper.pid,
        processIdentity,
        sessionId,
        socketPath,
        heartbeatAt: "2000-01-01T00:00:00.000Z",
      });

      const lease = await tryAcquireQueueOwnerLease(sessionId);
      assert.equal(lease, undefined);
      assert.equal((await readQueueOwnerRecord(sessionId))?.pid, keeper.pid);
      assert.equal(isProcessAlive(keeper.pid), true);
    } finally {
      stopProcess(keeper);
    }
  });
});

test("terminateProcess and terminateQueueOwnerForSession handle live and missing owners", async () => {
  await withTempHome(async (homeDir) => {
    assert.equal(isProcessAlive(undefined), false);
    assert.equal(isProcessAlive(process.pid), false);
    assert.equal(await terminateProcess(999_999), false);

    const sessionId = "terminate-owner";
    const keeper = await startKeeperProcess();
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);

    try {
      assert.equal(isProcessAlive(keeper.pid), true);
      const processIdentity = await readProcessIdentity(keeper.pid!);
      await writeQueueOwnerLock({
        lockPath,
        pid: keeper.pid,
        processIdentity,
        sessionId,
        socketPath,
      });

      await terminateQueueOwnerForSession(sessionId);
      assert.equal(await readQueueOwnerRecord(sessionId), undefined);
    } finally {
      stopProcess(keeper);
    }
  });
});

test("mismatched queue-owner identities are retired without signaling the reused pid", async (t) => {
  await withTempHome(async (homeDir) => {
    const sessionId = "reused-owner-pid";
    const keeper = await startKeeperProcess();
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);

    try {
      const processIdentity = await readProcessIdentity(keeper.pid!);
      if (!processIdentity) {
        t.skip("process identity unavailable in the managed environment");
        return;
      }
      await writeQueueOwnerLock({
        lockPath,
        pid: keeper.pid,
        processIdentity: `${processIdentity}-reused`,
        sessionId,
        socketPath,
      });

      const owner = await readQueueOwnerRecord(sessionId);
      assert(owner);
      assert.equal(await ensureOwnerIsUsable(sessionId, owner), false);
      assert.equal(await readQueueOwnerRecord(sessionId), undefined);
      assert.equal(isProcessAlive(keeper.pid), true);
    } finally {
      stopProcess(keeper);
      await fs.rm(lockPath, { force: true });
    }
  });
});

test("legacy queue-owner records are cleaned without signaling an unverifiable pid", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "legacy-owner-cleanup";
    const keeper = await startKeeperProcess();
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);

    try {
      await writeQueueOwnerLock({
        lockPath,
        pid: keeper.pid,
        sessionId,
        socketPath,
        heartbeatAt: "2000-01-01T00:00:00.000Z",
      });

      await terminateQueueOwnerForSession(sessionId);
      assert.equal(await readQueueOwnerRecord(sessionId), undefined);
      assert.equal(isProcessAlive(keeper.pid), true);
    } finally {
      stopProcess(keeper);
      await fs.rm(lockPath, { force: true });
    }
  });
});

test("terminateProcess waits long enough for a process that delays 2s before exiting on SIGTERM", async () => {
  // Regression test for the SIGTERM grace-period mismatch.
  //
  // A queue-owner's AcpClient.close() can take up to ~2 600 ms (stdin-close
  // 100 ms + SIGTERM wait 1 500 ms + SIGKILL wait 1 000 ms).  The old
  // PROCESS_EXIT_GRACE_MS of 1 500 ms would SIGKILL the owner before it
  // finished closing its bridge.  PROCESS_SIGTERM_GRACE_MS = 4 000 ms gives
  // sufficient headroom.
  //
  // This test spawns a Node.js process that defers its exit by 2 000 ms after
  // receiving SIGTERM and verifies that terminateProcess() returns true without
  // needing to escalate to SIGKILL (i.e. the process exits on its own within
  // the 4 s window).
  if (process.platform === "win32") {
    // SIGTERM semantics differ on Windows.
    return;
  }

  // The child writes "ready\n" to stderr once its SIGTERM handler is installed.
  // We wait for that line before sending SIGTERM to avoid the race where the
  // signal arrives before the handler is registered.
  const script = `
    process.on('SIGTERM', () => {
      setTimeout(() => process.exit(0), 2_000);
    });
    process.stderr.write('ready\\n');
    // Keep the event loop alive until SIGTERM arrives.
    setInterval(() => {}, 60_000);
  `;

  const child = spawn(process.execPath, ["-e", script], {
    stdio: ["ignore", "ignore", "pipe"],
  });

  // Wait for the "ready" signal before sending SIGTERM.
  await new Promise<void>((resolve, reject) => {
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      if (buf.includes("ready")) {
        child.stderr?.off("data", onData);
        resolve();
      }
    };
    child.stderr?.on("data", onData);
    child.once("exit", () => reject(new Error("child exited before signalling ready")));
  });

  assert(child.pid, "child must have a pid");

  try {
    assert.equal(isProcessAlive(child.pid), true, "child must be alive before terminateProcess");
    const result = await terminateProcess(child.pid);
    assert.equal(result, true, "terminateProcess must return true");
    assert.equal(isProcessAlive(child.pid), false, "process must be dead after terminateProcess");

    // Wait for the ChildProcess object to pick up the close event so that
    // exitCode / signalCode are populated.
    if (child.exitCode == null && child.signalCode == null) {
      await once(child, "close");
    }

    // The process should have exited with code 0 (clean exit via setTimeout),
    // not killed by a signal, proving the 4 s SIGTERM grace was enough.
    assert.equal(
      child.signalCode,
      null,
      `process should have exited cleanly, not via signal ${child.signalCode}`,
    );
    assert.equal(child.exitCode, 0, "process must exit with code 0");
  } finally {
    if (child.exitCode == null && child.signalCode == null) {
      child.kill("SIGKILL");
    }
  }
});
