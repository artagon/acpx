import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { AGENT_ARGV_REGISTRY, AGENT_REGISTRY } from "../src/agent-registry.js";
import { parseSessionRecord, serializeSessionRecordForDisk } from "../src/session/persistence.js";
import {
  fileExists,
  makeSessionRecord as makeSessionRecordFixture,
  sessionFilePath,
  withTempHome as withTempHomeFixture,
  writeSessionRecordFile as writeSessionRecord,
} from "./runtime-test-helpers.js";

type SessionModule = typeof import("../src/session/session.js");

const SESSION_MODULE_URL = new URL("../src/session/session.js", import.meta.url);
const SESSION_REPOSITORY_URL = new URL("../src/session/persistence/repository.js", import.meta.url);
const SESSION_WRITE_LOCK_URL = new URL("../src/session/persistence/write-lock.js", import.meta.url);

test("SessionRecord allows optional closed and closedAt fields", () => {
  const record = makeSessionRecord({
    acpxRecordId: "type-check",
    acpSessionId: "type-check",
    agentCommand: "agent",
    cwd: "/tmp/type-check",
  });

  assert.equal(record.closed, false);
  assert.equal(record.closedAt, undefined);
});

test("parseSessionRecord preserves structured agent argv", () => {
  const serialized = serializeSessionRecordForDisk(
    makeSessionRecord({
      acpxRecordId: "structured-agent-argv",
      acpSessionId: "structured-agent-argv",
      agentCommand: '"C:\\\\tools\\\\bin\\\\agent.sh"',
      agentArgv: ["C:\\tools\\bin\\agent.sh", "--pipe", "\\\\.\\pipe\\acpx-agent"],
      cwd: "/tmp/structured-agent-argv",
    }),
  );

  const parsed = parseSessionRecord(serialized);

  assert.ok(parsed);
  assert.deepEqual(parsed.agentArgv, [
    "C:\\tools\\bin\\agent.sh",
    "--pipe",
    "\\\\.\\pipe\\acpx-agent",
  ]);
});

test("parseSessionRecord backfills argv for legacy built-in records", () => {
  const serialized = serializeSessionRecordForDisk(
    makeSessionRecord({
      acpxRecordId: "legacy-built-in-argv",
      acpSessionId: "legacy-built-in-argv",
      agentCommand: AGENT_REGISTRY.codex,
      cwd: "/tmp/legacy-built-in-argv",
    }),
  );
  delete serialized.agent_argv;

  const parsed = parseSessionRecord(serialized);

  assert.ok(parsed);
  assert.deepEqual(parsed.agentArgv, AGENT_ARGV_REGISTRY.codex);
});

test("parseSessionRecord backfills argv for historical built-in commands", () => {
  for (const [agentCommand, expectedArgv] of [
    ["npx @zed-industries/codex-acp@^0.12.0", AGENT_ARGV_REGISTRY.codex],
    ["npm exec @agentclientprotocol/claude-agent-acp@^0.37.0", AGENT_ARGV_REGISTRY.claude],
    ["npx -y mux@^0.27.0 acp", AGENT_ARGV_REGISTRY.mux],
    ["gemini --experimental-acp", AGENT_ARGV_REGISTRY.gemini],
    ["kiro-cli acp", AGENT_ARGV_REGISTRY.kiro],
    ["npx opencode-ai", AGENT_ARGV_REGISTRY.opencode],
  ] as const) {
    const serialized = serializeSessionRecordForDisk(
      makeSessionRecord({
        acpxRecordId: agentCommand,
        acpSessionId: agentCommand,
        agentCommand,
        cwd: "/tmp/historical-built-in-argv",
      }),
    );
    delete serialized.agent_argv;

    const parsed = parseSessionRecord(serialized);

    assert.ok(parsed);
    assert.deepEqual(parsed.agentArgv, expectedArgv);
  }
});

test("parseSessionRecord preserves persisted session env", () => {
  const serialized = serializeSessionRecordForDisk(
    makeSessionRecord({
      acpxRecordId: "session-env-options",
      acpSessionId: "session-env-options",
      agentCommand: "agent",
      cwd: "/tmp/session-env-options",
      acpx: {
        session_options: {
          env: {
            GIT_AUTHOR_EMAIL: "agent@example.local",
          },
        },
      },
    }),
  );
  const acpx = serialized.acpx as Record<string, unknown>;
  const sessionOptions = acpx.session_options as { env: Record<string, unknown> };
  sessionOptions.env.IGNORED_NON_STRING = 123;

  const parsed = parseSessionRecord(serialized);

  assert.ok(parsed);
  assert.deepEqual(parsed.acpx?.session_options?.env, {
    GIT_AUTHOR_EMAIL: "agent@example.local",
  });
});

test("parseSessionRecord ignores malformed config options during model-control migration", () => {
  const serialized = serializeSessionRecordForDisk(
    makeSessionRecord({
      acpxRecordId: "malformed-config-options",
      acpSessionId: "malformed-config-options",
      agentCommand: "agent",
      cwd: "/tmp/malformed-config-options",
      acpx: {
        current_model_id: "legacy-model",
        available_models: ["legacy-model"],
      },
    }),
  );
  const acpx = serialized.acpx as Record<string, unknown>;
  acpx.config_options = [null];
  delete acpx.model_control;

  const parsed = parseSessionRecord(serialized);

  assert.ok(parsed);
  assert.equal(parsed.acpx?.config_options, undefined);
  assert.equal(parsed.acpx?.model_control, "legacy_set_model");
});

test("listSessions preserves acpx desired_mode_id", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "desired-mode",
        acpSessionId: "desired-mode",
        agentCommand: "agent-a",
        cwd,
        acpx: {
          desired_mode_id: "plan",
        },
      }),
    );

    const sessions = await session.listSessions();
    const record = sessions.find((entry) => entry.acpxRecordId === "desired-mode");
    assert.ok(record);
    assert.equal(record.acpx?.desired_mode_id, "plan");
  });
});

test("listSessions preserves acpx desired_config_options", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "desired-config-options",
        acpSessionId: "desired-config-options",
        agentCommand: "agent-a",
        cwd,
        acpx: {
          desired_config_options: {
            reasoning_effort: "high",
          },
        },
      }),
    );

    const sessions = await session.listSessions();
    const record = sessions.find((entry) => entry.acpxRecordId === "desired-config-options");
    assert.ok(record);
    assert.deepEqual(record.acpx?.desired_config_options, {
      reasoning_effort: "high",
    });
  });
});

test("listSessions migrates persisted legacy model control", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "legacy-model-control",
        acpSessionId: "legacy-model-control",
        agentCommand: "agent-a",
        cwd,
        acpx: {
          current_model_id: "legacy-model",
          available_models: ["legacy-model"],
          config_options: [],
        },
      }),
    );
    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "config-model-control",
        acpSessionId: "config-model-control",
        agentCommand: "agent-a",
        cwd,
        acpx: {
          current_model_id: "config-model",
          available_models: ["config-model"],
          config_options: [
            {
              id: "llm",
              name: "Model",
              category: "model",
              type: "select",
              currentValue: "config-model",
              options: [{ value: "config-model", name: "Config Model" }],
            },
          ],
        },
      }),
    );

    const sessions = await session.listSessions();
    const record = sessions.find((entry) => entry.acpxRecordId === "legacy-model-control");
    assert.ok(record);
    assert.equal(record.acpx?.model_control, "legacy_set_model");
    const configRecord = sessions.find((entry) => entry.acpxRecordId === "config-model-control");
    assert.ok(configRecord);
    assert.equal(configRecord.acpx?.model_control, "config_option");
  });
});

test("listSessions preserves acpx reset_on_next_ensure", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "reset-on-next-ensure",
        acpSessionId: "reset-on-next-ensure",
        agentCommand: "agent-a",
        cwd,
        acpx: {
          reset_on_next_ensure: true,
        },
      }),
    );

    const sessions = await session.listSessions();
    const record = sessions.find((entry) => entry.acpxRecordId === "reset-on-next-ensure");
    assert.ok(record);
    assert.equal(record.acpx?.reset_on_next_ensure, true);
  });
});

test("listSessions preserves acpx session_options", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "session-options",
        acpSessionId: "session-options",
        agentCommand: "agent-a",
        cwd,
        acpx: {
          session_options: {
            model: "sonnet",
            allowed_tools: ["Read", "Grep"],
            max_turns: 7,
          },
        },
      }),
    );

    const sessions = await session.listSessions();
    const record = sessions.find((entry) => entry.acpxRecordId === "session-options");
    assert.ok(record);
    assert.deepEqual(record.acpx?.session_options, {
      model: "sonnet",
      allowed_tools: ["Read", "Grep"],
      max_turns: 7,
    });
  });
});

test("listSessions preserves acpx session_options system_prompt string and append", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "session-system-prompt-string",
        acpSessionId: "session-system-prompt-string",
        agentCommand: "agent-a",
        cwd,
        acpx: {
          session_options: {
            system_prompt: "you are an obsidian assistant",
          },
        },
      }),
    );
    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "session-system-prompt-append",
        acpSessionId: "session-system-prompt-append",
        agentCommand: "agent-a",
        cwd,
        acpx: {
          session_options: {
            system_prompt: { append: "always speak in spanish" },
          },
        },
      }),
    );

    const sessions = await session.listSessions();
    const stringRecord = sessions.find(
      (entry) => entry.acpxRecordId === "session-system-prompt-string",
    );
    const appendRecord = sessions.find(
      (entry) => entry.acpxRecordId === "session-system-prompt-append",
    );
    assert.ok(stringRecord);
    assert.ok(appendRecord);
    assert.equal(
      stringRecord.acpx?.session_options?.system_prompt,
      "you are an obsidian assistant",
    );
    assert.deepEqual(appendRecord.acpx?.session_options?.system_prompt, {
      append: "always speak in spanish",
    });
  });
});

test("listSessions ignores unsupported conversation message shapes", async () => {
  await withTempHome(async (homeDir) => {
    const sessionDir = path.join(homeDir, ".acpx", "sessions");
    await fs.mkdir(sessionDir, { recursive: true });

    const malformed = makeSessionRecord({
      acpxRecordId: "malformed-shape",
      acpSessionId: "malformed-shape",
      agentCommand: "agent",
      cwd: path.join(homeDir, "workspace"),
    });

    (malformed as unknown as Record<string, unknown>).messages = [
      {
        kind: "user",
        id: "user_1",
        content: [{ type: "text", text: "invalid" }],
      },
    ];

    await fs.writeFile(
      path.join(sessionDir, "malformed-shape.json"),
      JSON.stringify(serializeSessionRecordForDisk(malformed), null, 2) + "\n",
      "utf8",
    );

    const session = await loadSessionModule();
    const sessions = await session.listSessions();
    assert.equal(
      sessions.some((entry) => entry.acpxRecordId === "malformed-shape"),
      false,
    );
  });
});

test("listSessions preserves lifecycle and conversation metadata", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "session-a",
        acpSessionId: "session-a",
        agentCommand: "agent-a",
        cwd,
        pid: 12345,
        agentStartedAt: "2026-01-01T00:00:00.000Z",
        lastPromptAt: "2026-01-01T00:01:00.000Z",
        lastAgentExitCode: null,
        lastAgentExitSignal: "SIGTERM",
        lastAgentExitAt: "2026-01-01T00:02:00.000Z",
        lastAgentDisconnectReason: "process_exit",
        title: "My Thread",
        messages: [
          {
            User: {
              id: "7c7615ad-5ba0-4cd3-a5f7-6ad9346dcfd5",
              content: [
                { Text: "hello" },
                { Audio: { source: "UklGRg==", mime_type: "audio/wav" } },
              ],
            },
          },
          {
            Agent: {
              content: [{ Text: "world" }],
              tool_results: {},
            },
          },
        ],
        updated_at: "2026-01-01T00:02:00.000Z",
        cumulative_token_usage: {},
        request_token_usage: {},
      }),
    );

    const sessions = await session.listSessions();
    const record = sessions.find((entry) => entry.acpxRecordId === "session-a");
    assert.ok(record);
    assert.equal(record.agentStartedAt, "2026-01-01T00:00:00.000Z");
    assert.equal(record.lastPromptAt, "2026-01-01T00:01:00.000Z");
    assert.equal(record.lastAgentExitCode, null);
    assert.equal(record.lastAgentExitSignal, "SIGTERM");
    assert.equal(record.lastAgentExitAt, "2026-01-01T00:02:00.000Z");
    assert.equal(record.lastAgentDisconnectReason, "process_exit");
    assert.equal(record.messages.length, 2);
    assert.deepEqual(record.messages[0], {
      User: {
        id: "7c7615ad-5ba0-4cd3-a5f7-6ad9346dcfd5",
        content: [{ Text: "hello" }, { Audio: { source: "UklGRg==", mime_type: "audio/wav" } }],
      },
    });
    assert.equal(record.title, "My Thread");
  });
});

test("listSessions preserves optional agentSessionId", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "workspace");

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "session-runtime",
        acpSessionId: "session-runtime",
        agentSessionId: "provider-runtime-123",
        agentCommand: "agent-a",
        cwd,
      }),
    );

    const sessions = await session.listSessions();
    const record = sessions.find((entry) => entry.acpxRecordId === "session-runtime");
    assert.ok(record);
    assert.equal(record.agentSessionId, "provider-runtime-123");
  });
});

test("findSession and findSessionByDirectoryWalk resolve expected records", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();

    const repoRoot = path.join(homeDir, "repo");
    const packagesDir = path.join(repoRoot, "packages");
    const nestedDir = path.join(packagesDir, "app");

    await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
    await fs.mkdir(nestedDir, { recursive: true });

    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "session-root",
        acpSessionId: "session-root",
        agentCommand: "agent-a",
        cwd: repoRoot,
      }),
    );
    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "session-packages",
        acpSessionId: "session-packages",
        agentCommand: "agent-a",
        cwd: packagesDir,
      }),
    );

    const foundDefault = await session.findSession({
      agentCommand: "agent-a",
      cwd: packagesDir,
    });
    assert.equal(foundDefault?.acpxRecordId, "session-packages");

    const boundary = session.findGitRepositoryRoot(nestedDir);
    const walked = await session.findSessionByDirectoryWalk({
      agentCommand: "agent-a",
      cwd: nestedDir,
      boundary,
    });
    assert.equal(walked?.acpxRecordId, "session-packages");
  });
});

test("writeSessionRecord maintains an index and listSessions rebuilds it when missing", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const cwd = path.join(homeDir, "repo");
    const record = makeSessionRecord({
      acpxRecordId: "indexed-session",
      acpSessionId: "indexed-session",
      agentCommand: "agent-a",
      cwd,
    });

    const indexPath = path.join(homeDir, ".acpx", "sessions", "index.json");
    await writeSessionRecord(homeDir, record);
    assert.equal(await fileExists(indexPath), false);

    const initialSessions = await session.listSessions();
    assert.equal(
      initialSessions.some((entry) => entry.acpxRecordId === "indexed-session"),
      true,
    );
    assert.equal(await fileExists(indexPath), true);

    await fs.rm(indexPath, { force: true });
    const sessions = await session.listSessions();
    assert.equal(
      sessions.some((entry) => entry.acpxRecordId === "indexed-session"),
      true,
    );
    assert.equal(await fileExists(indexPath), true);
  });
});

test("a dirty marker rebuilds index metadata after an interrupted record update", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const sessionDir = path.join(homeDir, ".acpx", "sessions");
    const recordPath = sessionFilePath(homeDir, "dirty-index-session");
    const dirtyPath = path.join(sessionDir, ".index.dirty");
    const cwd = path.join(homeDir, "repo");
    const initial = makeSessionRecord({
      acpxRecordId: "dirty-index-session",
      acpSessionId: "dirty-index-session",
      agentCommand: "agent-a",
      cwd,
      closed: false,
    });
    await writeSessionRecord(homeDir, initial);
    await session.listSessions();

    await fs.writeFile(
      recordPath,
      `${JSON.stringify(
        serializeSessionRecordForDisk({
          ...initial,
          closed: true,
          closedAt: "2026-01-01T00:00:00.000Z",
        }),
        null,
        2,
      )}\n`,
      "utf8",
    );
    await fs.writeFile(dirtyPath, "interrupted\n", "utf8");

    const found = await session.findSession({
      agentCommand: "agent-a",
      cwd,
    });
    assert.equal(found, undefined);
    assert.equal(await fileExists(dirtyPath), false);
  });
});

test("writeSessionRecord serializes cross-process record and index publication", async () => {
  await withTempHome(async (homeDir) => {
    const sessionDir = path.join(homeDir, ".acpx", "sessions");
    const indexPath = path.join(sessionDir, "index.json");
    const firstReadyPath = path.join(homeDir, "first-index-ready");
    const releaseFirstPath = path.join(homeDir, "release-first-index");
    const firstRecord = makeSessionRecord({
      acpxRecordId: "concurrent-first",
      acpSessionId: "concurrent-first",
      agentCommand: "agent-a",
      cwd: path.join(homeDir, "first"),
    });
    const secondRecord = makeSessionRecord({
      acpxRecordId: "concurrent-second",
      acpSessionId: "concurrent-second",
      agentCommand: "agent-a",
      cwd: path.join(homeDir, "second"),
    });
    const first = spawnSessionRecordWriter({
      homeDir,
      record: firstRecord,
      pauseIndexPath: indexPath,
      readyPath: firstReadyPath,
      releasePath: releaseFirstPath,
    });
    let second: ChildProcess | undefined;

    try {
      await waitForFile(firstReadyPath);
      second = spawnSessionRecordWriter({ homeDir, record: secondRecord });
      const secondResult = waitForSuccessfulChild(second);

      await Promise.race([secondResult, sleep(1_000)]);
      await fs.writeFile(releaseFirstPath, "release\n", "utf8");
      await Promise.all([waitForSuccessfulChild(first), secondResult]);

      const index = JSON.parse(await fs.readFile(indexPath, "utf8")) as {
        entries?: Array<{ acpxRecordId?: string }>;
      };
      assert.deepEqual(index.entries?.map((entry) => entry.acpxRecordId).toSorted(), [
        "concurrent-first",
        "concurrent-second",
      ]);
    } finally {
      await fs.writeFile(releaseFirstPath, "release\n", "utf8").catch(() => {});
      stopChild(first);
      if (second) {
        stopChild(second);
      }
    }
  });
});

test("writeSessionRecord recovers a stale cross-process write lock", async () => {
  await withTempHome(async (homeDir) => {
    const sessionDir = path.join(homeDir, ".acpx", "sessions");
    const lockPath = path.join(sessionDir, ".write.lock");
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      lockPath,
      `${JSON.stringify({
        lockId: "stale-writer",
        pid: 999_999,
        createdAt: "2000-01-01T00:00:00.000Z",
      })}\n`,
      "utf8",
    );
    const repository = await import(
      `${SESSION_REPOSITORY_URL.href}?write_lock_test=${Date.now()}-${Math.random()}`
    );

    await repository.writeSessionRecord(
      makeSessionRecord({
        acpxRecordId: "stale-lock-recovery",
        acpSessionId: "stale-lock-recovery",
        agentCommand: "agent-a",
        cwd: path.join(homeDir, "stale-lock"),
      }),
    );

    assert.equal(await fileExists(lockPath), false);
    assert.equal(
      (await fs.readdir(sessionDir)).some((name) => name.startsWith(".write.lock.reaper-")),
      false,
    );
  });
});

test("writeSessionRecord recovers an old malformed write lock", async () => {
  await withTempHome(async (homeDir) => {
    const sessionDir = path.join(homeDir, ".acpx", "sessions");
    const lockPath = path.join(sessionDir, ".write.lock");
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(lockPath, '{"lockId":', "utf8");
    const oldTime = new Date(Date.now() - 180_000);
    await fs.utimes(lockPath, oldTime, oldTime);
    const repository = await import(
      `${SESSION_REPOSITORY_URL.href}?malformed_write_lock_test=${Date.now()}-${Math.random()}`
    );

    await repository.writeSessionRecord(
      makeSessionRecord({
        acpxRecordId: "malformed-lock-recovery",
        acpSessionId: "malformed-lock-recovery",
        agentCommand: "agent-a",
        cwd: path.join(homeDir, "malformed-lock"),
      }),
    );

    assert.equal(await fileExists(lockPath), false);
  });
});

test("session write locks are not visible until their complete record is published", async () => {
  await withTempHome(async (homeDir) => {
    const sessionDir = path.join(homeDir, "sessions");
    const lockPath = path.join(sessionDir, ".write.lock");
    await fs.mkdir(sessionDir, { recursive: true });
    const { withSessionWriteLock } = await import(
      `${SESSION_WRITE_LOCK_URL.href}?atomic_publication=${Date.now()}-${Math.random()}`
    );
    const originalWriteFile = fs.writeFile.bind(fs);
    let releaseWrite: (() => void) | undefined;
    const writeReleased = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let partialWriteReady: (() => void) | undefined;
    const partialWriteStarted = new Promise<void>((resolve) => {
      partialWriteReady = resolve;
    });
    let intercepted = false;

    Object.defineProperty(fs, "writeFile", {
      configurable: true,
      value: async (
        file: Parameters<typeof fs.writeFile>[0],
        data: Parameters<typeof fs.writeFile>[1],
        options?: Parameters<typeof fs.writeFile>[2],
      ) => {
        const fileName =
          typeof file === "string"
            ? path.basename(file)
            : file instanceof URL
              ? path.basename(file.pathname)
              : Buffer.isBuffer(file)
                ? path.basename(file.toString())
                : "";
        if (!intercepted && fileName.startsWith(".write.lock")) {
          intercepted = true;
          await originalWriteFile(file, '{"lockId":', options);
          partialWriteReady?.();
          await writeReleased;
          await originalWriteFile(file, data, {
            encoding: "utf8",
            flag: "w",
            mode: 0o600,
          });
          return;
        }
        return await originalWriteFile(file, data, options);
      },
    });

    const lockedOperation = withSessionWriteLock(sessionDir, async () => {});
    let publishedWhilePartial = false;
    try {
      await partialWriteStarted;
      publishedWhilePartial = await fileExists(lockPath);
    } finally {
      Object.defineProperty(fs, "writeFile", {
        configurable: true,
        value: originalWriteFile,
      });
      releaseWrite?.();
      await lockedOperation;
    }

    assert.equal(publishedWhilePartial, false);
    assert.equal(
      (await fs.readdir(sessionDir)).some((name) => name.startsWith(".write.lock.")),
      false,
    );
  });
});

test("session write lock reentrancy canonicalizes symlink aliases", async () => {
  await withTempHome(async (homeDir) => {
    const realSessionDir = path.join(homeDir, "real-sessions");
    const aliasSessionDir = path.join(homeDir, "session-alias");
    await fs.mkdir(realSessionDir, { recursive: true });
    await fs.symlink(
      realSessionDir,
      aliasSessionDir,
      process.platform === "win32" ? "junction" : "dir",
    );
    const { withSessionWriteLock } = await import(
      `${SESSION_WRITE_LOCK_URL.href}?symlink_reentrancy=${Date.now()}-${Math.random()}`
    );
    let nestedOperationRan = false;

    await withSessionWriteLock(aliasSessionDir, async () => {
      await withSessionWriteLock(realSessionDir, async () => {
        nestedOperationRan = true;
      });
    });

    assert.equal(nestedOperationRan, true);
  });
});

test("session write locks preserve live owners without a verifiable process identity", async () => {
  await withTempHome(async (homeDir) => {
    const sessionDir = path.join(homeDir, "sessions");
    const lockPath = path.join(sessionDir, ".write.lock");
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      lockPath,
      `${JSON.stringify({
        lockId: "live-legacy-writer",
        pid: process.pid,
        createdAt: "2000-01-01T00:00:00.000Z",
      })}\n`,
      "utf8",
    );
    const staleTime = new Date("2000-01-01T00:00:00.000Z");
    await fs.utimes(lockPath, staleTime, staleTime);
    const writeLockModule = await import(
      `${SESSION_WRITE_LOCK_URL.href}?live_legacy=${Date.now()}-${Math.random()}`
    );

    assert.equal(
      await writeLockModule.sessionWriteLockIsStale(lockPath, await fs.lstat(lockPath)),
      false,
    );
  });
});

test("closeSession soft-closes and terminates matching process", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();

    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
      stdio: "ignore",
    });
    await once(child, "spawn");

    const sessionId = "live-session";
    const cwd = path.join(homeDir, "repo");
    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: sessionId,
        acpSessionId: sessionId,
        agentCommand: process.execPath,
        cwd,
        pid: child.pid,
      }),
    );

    const filePath = sessionFilePath(homeDir, sessionId);

    try {
      const closed = await session.closeSession(sessionId);
      assert.equal(closed.closed, true);
      assert.equal(typeof closed.closedAt, "string");
      assert.equal(closed.pid, undefined);
      assert.equal(await fileExists(filePath), true);

      const stored = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
      assert.equal(stored.closed, true);
      assert.equal(typeof stored.closed_at, "string");

      const exited = await waitForExit(child.pid);
      assert.equal(exited, true);
    } finally {
      if (child.exitCode == null && child.signalCode == null) {
        child.kill("SIGKILL");
      }
    }
  });
});

test("closeSession does not signal a live process that does not match the recorded agent", async () => {
  await withTempHome(async (homeDir) => {
    const repository = await import(
      `${SESSION_REPOSITORY_URL.href}?close_process_match=${Date.now()}-${Math.random()}`
    );
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
      stdio: "ignore",
    });
    await once(child, "spawn");

    const sessionId = "mismatched-live-session";
    await writeSessionRecord(
      homeDir,
      makeSessionRecord({
        acpxRecordId: sessionId,
        acpSessionId: sessionId,
        agentCommand: "definitely-not-the-node-runtime",
        cwd: path.join(homeDir, "repo"),
        pid: child.pid,
      }),
    );

    try {
      await repository.closeSession(sessionId);
      await sleep(100);
      assert.equal(await waitForExit(child.pid), false);
    } finally {
      stopChild(child);
    }
  });
});

test("closeSession reads and updates the record while holding the session write lock", async () => {
  await withTempHome(async (homeDir) => {
    const session = await loadSessionModule();
    const sessionDir = path.join(homeDir, ".acpx", "sessions");
    const lockPath = path.join(sessionDir, ".write.lock");
    const sessionId = "concurrent-close";
    const initial = makeSessionRecord({
      acpxRecordId: sessionId,
      acpSessionId: sessionId,
      agentCommand: "agent-a",
      cwd: path.join(homeDir, "repo"),
      title: "initial title",
    });
    await writeSessionRecord(homeDir, initial);
    await session.listSessions();
    await fs.writeFile(
      lockPath,
      `${JSON.stringify({
        lockId: "active-writer",
        pid: process.pid,
        createdAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );

    const closing = session.closeSession(sessionId);
    await sleep(200);
    await fs.writeFile(
      sessionFilePath(homeDir, sessionId),
      `${JSON.stringify(
        serializeSessionRecordForDisk({
          ...initial,
          title: "concurrent title",
        }),
        null,
        2,
      )}\n`,
      "utf8",
    );
    await fs.unlink(lockPath);

    await closing;
    const stored = parseSessionRecord(
      JSON.parse(await fs.readFile(sessionFilePath(homeDir, sessionId), "utf8")),
    );
    assert.ok(stored);
    assert.equal(stored.closed, true);
    assert.equal(stored.title, "concurrent title");
  });
});

test("normalizeQueueOwnerTtlMs applies default and edge-case normalization", async () => {
  await withTempHome(async () => {
    const session = await loadSessionModule();
    assert.equal(session.normalizeQueueOwnerTtlMs(undefined), session.DEFAULT_QUEUE_OWNER_TTL_MS);
    assert.equal(session.normalizeQueueOwnerTtlMs(0), 0);
    assert.equal(session.normalizeQueueOwnerTtlMs(-1), session.DEFAULT_QUEUE_OWNER_TTL_MS);
    assert.equal(session.normalizeQueueOwnerTtlMs(Number.NaN), session.DEFAULT_QUEUE_OWNER_TTL_MS);
    assert.equal(
      session.normalizeQueueOwnerTtlMs(Number.POSITIVE_INFINITY),
      session.DEFAULT_QUEUE_OWNER_TTL_MS,
    );
    assert.equal(
      session.normalizeQueueOwnerTtlMs(Number.NEGATIVE_INFINITY),
      session.DEFAULT_QUEUE_OWNER_TTL_MS,
    );
    assert.equal(session.normalizeQueueOwnerTtlMs(1.6), 2);
    assert.equal(session.normalizeQueueOwnerTtlMs(15_000), 15_000);
  });
});

async function loadSessionModule(): Promise<SessionModule> {
  const cacheBuster = `${Date.now()}-${Math.random()}`;
  return (await import(`${SESSION_MODULE_URL.href}?session_test=${cacheBuster}`)) as SessionModule;
}

async function withTempHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  await withTempHomeFixture("acpx-test-home-", run);
}

function makeSessionRecord(
  overrides: Parameters<typeof makeSessionRecordFixture>[0],
): ReturnType<typeof makeSessionRecordFixture> {
  return makeSessionRecordFixture(overrides, { defaultName: false, defaultAcpx: false });
}

function spawnSessionRecordWriter(options: {
  homeDir: string;
  record: ReturnType<typeof makeSessionRecord>;
  pauseIndexPath?: string;
  readyPath?: string;
  releasePath?: string;
}): ChildProcess {
  const script = `
    import fs from "node:fs/promises";
    const pauseIndexPath = ${JSON.stringify(options.pauseIndexPath)};
    const readyPath = ${JSON.stringify(options.readyPath)};
    const releasePath = ${JSON.stringify(options.releasePath)};
    if (pauseIndexPath && readyPath && releasePath) {
      const originalRename = fs.rename.bind(fs);
      let paused = false;
      fs.rename = async (source, destination) => {
        if (!paused && String(destination) === pauseIndexPath) {
          paused = true;
          await fs.writeFile(readyPath, "ready\\n", "utf8");
          for (;;) {
            try {
              await fs.access(releasePath);
              break;
            } catch {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }
        }
        return await originalRename(source, destination);
      };
    }
    const repository = await import(${JSON.stringify(SESSION_REPOSITORY_URL.href)});
    await repository.writeSessionRecord(${JSON.stringify(options.record)});
  `;
  return spawn(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, HOME: options.homeDir },
    stdio: ["ignore", "ignore", "pipe"],
  });
}

async function waitForSuccessfulChild(child: ChildProcess): Promise<void> {
  const stderrChunks: Buffer[] = [];
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk);
  });
  const [code, signal] = (await once(child, "close")) as [number | null, string | null];
  assert.equal(
    code,
    0,
    `session writer failed: signal=${signal ?? "none"} stderr=${Buffer.concat(stderrChunks).toString("utf8")}`,
  );
}

function stopChild(child: ChildProcess): void {
  if (child.exitCode == null && child.signalCode == null) {
    child.kill("SIGKILL");
  }
}

async function waitForFile(filePath: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fileExists(filePath)) {
      return;
    }
    await sleep(10);
  }
  throw new Error(`Timed out waiting for file: ${filePath}`);
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForExit(pid: number | undefined): Promise<boolean> {
  if (pid == null) {
    return true;
  }

  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
  }

  return false;
}
