import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  appendBenchmarkTrace,
  parseBenchmarkAgentArgs,
  type BenchmarkTraceEvent,
} from "../scripts/perf/benchmark-agent.js";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const BENCHMARK_AGENT_PATH = fileURLToPath(
  new URL("../scripts/perf/benchmark-agent.js", import.meta.url),
);

type CliRunResult = Readonly<{
  code: number | null;
  stderr: string;
  stdout: string;
}>;

function parseTraceEvents(traceFile: string): readonly BenchmarkTraceEvent[] {
  const contents = readFileSync(traceFile, "utf8").trim();
  return contents.split("\n").map((line) => {
    const value: unknown = JSON.parse(line);
    assert.ok(isBenchmarkTraceEvent(value));
    return value;
  });
}

function isBenchmarkTraceEvent(value: unknown): value is BenchmarkTraceEvent {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const event = Reflect.get(value, "event");
  const pid = Reflect.get(value, "pid");
  const timestampMs = Reflect.get(value, "timestampMs");
  return (
    isBenchmarkTraceEventName(event) &&
    typeof pid === "number" &&
    typeof timestampMs === "number" &&
    Number.isFinite(timestampMs)
  );
}

function isBenchmarkTraceEventName(value: unknown): value is BenchmarkTraceEvent["event"] {
  return (
    value === "agent.process_start" ||
    value === "agent.initialize.start" ||
    value === "agent.initialize.end" ||
    value === "agent.session_list.start" ||
    value === "agent.session_list.end" ||
    value === "agent.new_session.start" ||
    value === "agent.new_session.end" ||
    value === "agent.prompt.start" ||
    value === "agent.prompt.end" ||
    value === "agent.stdin_end" ||
    value === "agent.sigterm" ||
    value === "agent.exit"
  );
}

function assertOrderedScenarioTrace(
  events: readonly BenchmarkTraceEvent["event"][],
  workloadStart: BenchmarkTraceEvent["event"],
  workloadEnd: BenchmarkTraceEvent["event"],
): void {
  const startIndex = events.indexOf(workloadStart);
  const endIndex = events.indexOf(workloadEnd);
  const terminalIndex = events.findIndex(
    (event, index) =>
      index > endIndex &&
      (event === "agent.stdin_end" || event === "agent.sigterm" || event === "agent.exit"),
  );

  assert.ok(startIndex >= 0, `missing ${workloadStart}`);
  assert.ok(endIndex > startIndex, `${workloadEnd} must follow ${workloadStart}`);
  assert.ok(terminalIndex > endIndex, "terminal event must follow the workload");
}

async function runCli(args: readonly string[], homeDir: string): Promise<CliRunResult> {
  return await new Promise<CliRunResult>((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: homeDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
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
    child.once("close", (code) => {
      resolve({ code, stderr, stdout });
    });
  });
}

async function withTempDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-benchmark-agent-"));
  try {
    await run(directory);
  } finally {
    await fs.rm(directory, { force: true, maxRetries: 3, recursive: true, retryDelay: 50 });
  }
}

test("appendBenchmarkTrace does not create a trace when tracing is disabled", async () => {
  await withTempDirectory(async (directory) => {
    const traceFile = path.join(directory, "trace.ndjson");

    appendBenchmarkTrace(undefined, "agent.process_start");

    assert.equal(existsSync(traceFile), false);
  });
});

test("appendBenchmarkTrace writes ordered newline-delimited events", async () => {
  await withTempDirectory(async (directory) => {
    const traceFile = path.join(directory, "trace.ndjson");

    appendBenchmarkTrace(traceFile, "agent.process_start");
    appendBenchmarkTrace(traceFile, "agent.initialize.start");

    const events = parseTraceEvents(traceFile);
    assert.deepEqual(
      events.map((event) => event.event),
      ["agent.process_start", "agent.initialize.start"],
    );
    assert.equal(events[0]?.pid, process.pid);
    assert.ok(Number.isFinite(events[0]?.timestampMs));
  });
});

test("parseBenchmarkAgentArgs accepts only an optional trace file", () => {
  assert.deepEqual(parseBenchmarkAgentArgs([]), {});
  assert.deepEqual(parseBenchmarkAgentArgs(["--trace-file", "/tmp/trace.ndjson"]), {
    traceFile: "/tmp/trace.ndjson",
  });
  assert.throws(() => parseBenchmarkAgentArgs(["--unexpected"]), /unknown argument/i);
  assert.throws(() => parseBenchmarkAgentArgs(["--trace-file"]), /requires a path/i);
  assert.throws(() => parseBenchmarkAgentArgs(["--trace-file", "--unknown"]), /requires a path/i);
});

test("the built benchmark agent traces ordered session list and exec workloads", async () => {
  await withTempDirectory(async (directory) => {
    const homeDir = path.join(directory, "home");
    const workspace = path.join(directory, "workspace");
    const configFile = path.join(homeDir, ".acpx", "config.json");
    const writeBenchmarkConfig = async (traceFile: string): Promise<void> => {
      const agentCommand = `${JSON.stringify(process.execPath)} ${JSON.stringify(BENCHMARK_AGENT_PATH)} --trace-file ${JSON.stringify(traceFile)}`;
      await fs.writeFile(
        configFile,
        `${JSON.stringify({ agents: { benchmark: { command: agentCommand } } })}\n`,
        "utf8",
      );
    };

    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.mkdir(workspace, { recursive: true });
    const listTraceFile = path.join(directory, "list.ndjson");
    await writeBenchmarkConfig(listTraceFile);

    const list = await runCli(["--cwd", workspace, "benchmark", "sessions", "list"], homeDir);
    assert.equal(list.code, 0, list.stderr);
    const listEvents = parseTraceEvents(listTraceFile).map((event) => event.event);
    assertOrderedScenarioTrace(listEvents, "agent.initialize.start", "agent.initialize.end");
    assertOrderedScenarioTrace(listEvents, "agent.session_list.start", "agent.session_list.end");

    const execTraceFile = path.join(directory, "exec.ndjson");
    await writeBenchmarkConfig(execTraceFile);
    const exec = await runCli(["--cwd", workspace, "benchmark", "exec", "benchmark prompt"], homeDir);
    assert.equal(exec.code, 0, exec.stderr);
    assert.match(exec.stdout, /benchmark agent response/u);

    const execEvents = parseTraceEvents(execTraceFile).map((event) => event.event);
    assertOrderedScenarioTrace(execEvents, "agent.initialize.start", "agent.initialize.end");
    assertOrderedScenarioTrace(execEvents, "agent.new_session.start", "agent.new_session.end");
    assertOrderedScenarioTrace(execEvents, "agent.prompt.start", "agent.prompt.end");
  });
});
