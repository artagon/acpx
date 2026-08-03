import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_SCENARIO_ORDER,
  assertBenchmarkPlatform,
  benchmarkScenarioDefinition,
  parseBenchmarkArgs,
  runBenchmark,
  waitForBenchmarkChild,
  writeBenchmarkReport,
} from "../scripts/perf/benchmark-runner.js";
import type { BenchmarkOptions } from "../scripts/perf/benchmark-runner.js";

type FakeBehavior = "always-fail" | "fail-after-preflight" | "success";

type FakeVariantOptions = Readonly<{
  behavior?: FakeBehavior;
  delayMs?: number;
  logPath?: string;
  mutation?: Readonly<{
    contents: string;
    invocation: number;
    path: string;
  }>;
  spawnAgentChild?: boolean;
  stderrMarker?: string;
}>;

type InvocationRecord = Readonly<{
  args: readonly string[];
  cwd: string;
  home: string;
  label: string;
  metrics: boolean;
  trace: boolean;
  userprofile: string | null;
}>;

type CommandResult = Readonly<{
  code: number | null;
  stderr: string;
}>;

async function runCommand(command: string, args: readonly string[]): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ code, stderr });
    });
  });
}

async function initializeGitRepository(directory: string): Promise<void> {
  for (const args of [
    ["-C", directory, "init"],
    ["-C", directory, "add", "."],
    [
      "-C",
      directory,
      "-c",
      "user.name=Benchmark Test",
      "-c",
      "user.email=benchmark@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "fixture",
    ],
  ]) {
    const result = await runCommand("git", args);
    assert.equal(result.code, 0, result.stderr);
  }
}

function fakeCliSource(label: string, options: FakeVariantOptions): string {
  const behavior = options.behavior ?? "success";
  const stderrMarker = options.stderrMarker ?? "fake CLI failure";
  const logPath = options.logPath;
  const delayMs = options.delayMs ?? 0;
  const mutation = options.mutation;
  const spawnAgentChild = options.spawnAgentChild ?? true;
  return `
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

const label = ${JSON.stringify(label)};
const behavior = ${JSON.stringify(behavior)};
const stderrMarker = ${JSON.stringify(stderrMarker)};
const logPath = ${JSON.stringify(logPath)};
const delayMs = ${JSON.stringify(delayMs)};
const mutation = ${JSON.stringify(mutation)};
const spawnAgentChild = ${JSON.stringify(spawnAgentChild)};
const statePath = new URL("./invocations.txt", import.meta.url);
const previous = fs.existsSync(statePath) ? Number(fs.readFileSync(statePath, "utf8")) : 0;
const invocation = previous + 1;
fs.writeFileSync(statePath, String(invocation), "utf8");
await new Promise((resolve) => setTimeout(resolve, 100));

const metricsPath = process.env.ACPX_PERF_METRICS_FILE;
const configPath = path.join(os.homedir(), ".acpx", "config.json");
let tracePath;
if (fs.existsSync(configPath)) {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const argv = config?.agents?.benchmark?.argv;
  if (Array.isArray(argv)) {
    const traceIndex = argv.indexOf("--trace-file");
    tracePath = traceIndex >= 0 ? argv[traceIndex + 1] : undefined;
  }
}

const invocationArgs = process.argv.slice(2);
const usesAgent =
  invocationArgs.includes("exec") ||
  (invocationArgs.includes("sessions") && !invocationArgs.includes("--local"));
if (usesAgent && spawnAgentChild) {
  const agentChild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
    detached: true,
    stdio: "ignore",
  });
  agentChild.unref();
  await new Promise((resolve) => setTimeout(resolve, 100));
}

if (typeof logPath === "string") {
  fs.appendFileSync(
    logPath,
    JSON.stringify({
      args: process.argv.slice(2),
      cwd: process.cwd(),
      home: os.homedir(),
      label,
      metrics: typeof metricsPath === "string",
      trace: typeof tracePath === "string",
      userprofile: process.env.USERPROFILE ?? null,
    }) + "\\n",
    "utf8",
  );
}

if (behavior === "always-fail" || (behavior === "fail-after-preflight" && invocation > 1)) {
  process.stderr.write(stderrMarker + "\\n");
  process.exitCode = 9;
} else {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  const now = performance.timeOrigin + performance.now();
  if (typeof tracePath === "string") {
    fs.writeFileSync(
      tracePath,
      [
        { event: "agent.process_start", pid: process.pid, timestampMs: now },
        { event: "agent.prompt.end", pid: process.pid, timestampMs: now + 0.01 },
      ].map((event) => JSON.stringify(event)).join("\\n") + "\\n",
      "utf8",
    );
  }
  if (typeof metricsPath === "string") {
    fs.writeFileSync(
      metricsPath,
      JSON.stringify({
        role: "cli",
        metrics: {
          timings: {
            "fake.stage": { count: 2, totalMs: 3, maxMs: 2 },
          },
        },
      }) + "\\n",
      "utf8",
    );
  }
  process.stdout.write(label + " ok\\n");
}

if (mutation && invocation === mutation.invocation) {
  fs.writeFileSync(mutation.path, mutation.contents, "utf8");
}
`;
}

async function createFakeVariant(
  root: string,
  label: string,
  options: FakeVariantOptions = {},
): Promise<string> {
  const worktree = path.join(root, label);
  const distDirectory = path.join(worktree, "dist");
  await fs.mkdir(distDirectory, { recursive: true });
  await fs.writeFile(path.join(distDirectory, "cli.js"), fakeCliSource(label, options), "utf8");
  await initializeGitRepository(worktree);
  return worktree;
}

async function createProvenanceVariant(root: string, label: string): Promise<string> {
  const worktree = path.join(root, label);
  const distDirectory = path.join(worktree, "dist");
  await fs.mkdir(distDirectory, { recursive: true });
  await fs.writeFile(
    path.join(distDirectory, "cli.js"),
    "await new Promise((resolve) => setTimeout(resolve, 100));\nprocess.exitCode = 0;\n",
    "utf8",
  );
  await initializeGitRepository(worktree);
  return worktree;
}

async function withTempDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-benchmark-runner-"));
  try {
    await run(directory);
  } finally {
    await fs.rm(directory, { force: true, maxRetries: 3, recursive: true, retryDelay: 50 });
  }
}

function benchmarkOptions(
  baseline: Readonly<{ label: string; worktree: string }>,
  candidates: readonly Readonly<{ label: string; worktree: string }>[],
  outputDirectory: string,
  overrides: Partial<BenchmarkOptions> = {},
): BenchmarkOptions {
  return {
    baseline,
    candidates,
    scenarios: ["version"],
    samplesOverride: 1,
    warmupsOverride: 0,
    seed: 2_886_672_422,
    outputDirectory,
    ...overrides,
  };
}

async function readInvocationRecords(logPath: string): Promise<readonly InvocationRecord[]> {
  const contents = await fs.readFile(logPath, "utf8");
  return contents
    .trim()
    .split("\n")
    .map((line) => {
      const value: unknown = JSON.parse(line);
      if (typeof value !== "object" || value === null) {
        assert.fail("expected invocation log record");
      }
      const args = Reflect.get(value, "args");
      const cwd = Reflect.get(value, "cwd");
      const home = Reflect.get(value, "home");
      const label = Reflect.get(value, "label");
      const metrics = Reflect.get(value, "metrics");
      const trace = Reflect.get(value, "trace");
      const userprofile = Reflect.get(value, "userprofile");
      assert.ok(Array.isArray(args) && args.every((arg) => typeof arg === "string"));
      assert.equal(typeof cwd, "string");
      assert.equal(typeof home, "string");
      assert.equal(typeof label, "string");
      assert.equal(typeof metrics, "boolean");
      assert.equal(typeof trace, "boolean");
      assert.ok(typeof userprofile === "string" || userprofile === null);
      return { args, cwd, home, label, metrics, trace, userprofile };
    });
}

async function waitForPidFile(filePath: string): Promise<readonly [number, number]> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const value: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
      if (typeof value === "object" && value !== null) {
        const rootPid = Reflect.get(value, "rootPid");
        const grandchildPid = Reflect.get(value, "grandchildPid");
        if (typeof rootPid === "number" && typeof grandchildPid === "number") {
          return [rootPid, grandchildPid];
        }
      }
    } catch {
      // The fixture may not have written its ready file yet.
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error("timed out waiting for benchmark process fixture");
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killProcessTreeFixtureBestEffort(rootPid: number, descendantPid?: number): void {
  if (process.platform !== "win32") {
    try {
      process.kill(-rootPid, "SIGKILL");
    } catch {
      // The fixture group may already be gone.
    }
  }
  for (const pid of [rootPid, descendantPid]) {
    if (pid === undefined) {
      continue;
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The fixture process may already be gone.
    }
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100 && isProcessRunning(pid); attempt += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  assert.equal(isProcessRunning(pid), false, `process ${pid} must exit`);
}

async function assertHeartbeatStopped(heartbeatPath: string): Promise<void> {
  const before = await fs.readFile(heartbeatPath, "utf8");
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 100);
  });
  const after = await fs.readFile(heartbeatPath, "utf8");
  assert.equal(after, before, "descendant heartbeat must stop after cleanup");
}

async function assertHeartbeatContinues(heartbeatPath: string): Promise<void> {
  const before = await fs.readFile(heartbeatPath, "utf8");
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 100);
  });
  const after = await fs.readFile(heartbeatPath, "utf8");
  assert.notEqual(after, before, "live descendant heartbeat must continue");
}

async function canEnumerateProcesses(): Promise<boolean> {
  try {
    return (await runCommand("ps", ["-o", "pid=", "-p", String(process.pid)])).code === 0;
  } catch {
    return false;
  }
}

test("exposes the exact default scenario order, commands, argv, and counts", () => {
  assert.deepEqual(DEFAULT_SCENARIO_ORDER, [
    "version",
    "help",
    "local-sessions",
    "agent-sessions",
    "exec",
  ]);
  assert.deepEqual(benchmarkScenarioDefinition("version"), {
    args: ["--version"],
    command: "acpx --version",
    configuration: { samples: 100, warmups: 15 },
    usesAgent: false,
    workloadEndEvent: null,
  });
  assert.deepEqual(benchmarkScenarioDefinition("help"), {
    args: ["--help"],
    command: "acpx --help",
    configuration: { samples: 80, warmups: 12 },
    usesAgent: false,
    workloadEndEvent: null,
  });
  assert.deepEqual(benchmarkScenarioDefinition("local-sessions"), {
    args: ["--format", "quiet", "benchmark", "sessions", "list", "--local"],
    command: "acpx --format quiet benchmark sessions list --local",
    configuration: { samples: 50, warmups: 8 },
    usesAgent: false,
    workloadEndEvent: null,
  });
  assert.deepEqual(benchmarkScenarioDefinition("agent-sessions"), {
    args: ["--format", "quiet", "benchmark", "sessions", "list"],
    command: "acpx --format quiet benchmark sessions list",
    configuration: { samples: 25, warmups: 5 },
    usesAgent: true,
    workloadEndEvent: "agent.session_list.end",
  });
  assert.deepEqual(benchmarkScenarioDefinition("exec"), {
    args: ["--format", "quiet", "benchmark", "exec", "benchmark prompt"],
    command: "acpx --format quiet benchmark exec 'benchmark prompt'",
    configuration: { samples: 25, warmups: 5 },
    usesAgent: true,
    workloadEndEvent: "agent.prompt.end",
  });
});

test("parses repeated candidates and scenarios with resolved paths", () => {
  const options = parseBenchmarkArgs([
    "--baseline",
    "main=./main",
    "--candidate",
    "first=./first",
    "--candidate",
    "second=./second",
    "--scenario",
    "version",
    "--scenario",
    "exec",
    "--samples",
    "3",
    "--warmups",
    "0",
    "--seed",
    "2886672422",
    "--output",
    "./benchmark-output",
  ]);

  assert.deepEqual(options, {
    baseline: { label: "main", worktree: path.resolve("main") },
    candidates: [
      { label: "first", worktree: path.resolve("first") },
      { label: "second", worktree: path.resolve("second") },
    ],
    scenarios: ["version", "exec"],
    samplesOverride: 3,
    warmupsOverride: 0,
    seed: 2_886_672_422,
    outputDirectory: path.resolve("benchmark-output"),
  });
});

test("normalizes exactly one leading npm-run argument delimiter", () => {
  const options = parseBenchmarkArgs([
    "--",
    "--baseline",
    "main=./main",
    "--candidate",
    "next=./next",
    "--scenario",
    "version",
  ]);

  assert.deepEqual(options.baseline, { label: "main", worktree: path.resolve("main") });
  assert.deepEqual(options.candidates, [{ label: "next", worktree: path.resolve("next") }]);
  assert.deepEqual(options.scenarios, ["version"]);
  assert.throws(() =>
    parseBenchmarkArgs(["--", "--", "--baseline", "main=./main", "--candidate", "next=./next"]),
  );
});

test("validates unique labels, counts, seed, and scenario names", () => {
  assert.throws(
    () => parseBenchmarkArgs(["--baseline", "same=./main", "--candidate", "same=./candidate"]),
    /unique.*same/iu,
  );
  assert.throws(
    () => parseBenchmarkArgs(["--baseline", "main=.", "--candidate", "pr=.", "--samples", "0"]),
    /samples.*positive/iu,
  );
  assert.throws(
    () => parseBenchmarkArgs(["--baseline", "main=.", "--candidate", "pr=.", "--warmups=-1"]),
    /warmups.*nonnegative/iu,
  );
  assert.throws(
    () =>
      parseBenchmarkArgs(["--baseline", "main=.", "--candidate", "pr=.", "--seed", "4294967296"]),
    /seed.*unsigned 32-bit/iu,
  );
  assert.throws(
    () =>
      parseBenchmarkArgs(["--baseline", "main=.", "--candidate", "pr=.", "--scenario", "network"]),
    /scenario.*network/iu,
  );
});

test("rejects Windows execution while keeping argument parsing platform-neutral", () => {
  assert.doesNotThrow(() =>
    parseBenchmarkArgs(["--baseline", "base=.", "--candidate", "next=..", "--scenario", "version"]),
  );
  assert.throws(
    () => assertBenchmarkPlatform("win32"),
    /requires POSIX process groups.*Windows is not supported/iu,
  );
  assert.doesNotThrow(() => assertBenchmarkPlatform("linux"));
});

test("rejects variants without a resolvable Git HEAD or built CLI before creating output", async () => {
  await withTempDirectory(async (directory) => {
    const valid = await createFakeVariant(directory, "valid");
    const noGit = path.join(directory, "no-git");
    await fs.mkdir(path.join(noGit, "dist"), { recursive: true });
    await fs.writeFile(path.join(noGit, "dist", "cli.js"), "export {};\n", "utf8");
    const noBuild = path.join(directory, "no-build");
    await fs.mkdir(noBuild);
    await fs.writeFile(path.join(noBuild, "README.md"), "fixture\n", "utf8");
    await initializeGitRepository(noBuild);

    const gitOutput = path.join(directory, "git-output");
    await assert.rejects(
      runBenchmark(
        benchmarkOptions(
          { label: "valid", worktree: valid },
          [{ label: "no-git", worktree: noGit }],
          gitOutput,
        ),
      ),
      /no-git.*Git HEAD/iu,
    );
    await assert.rejects(
      runBenchmark(
        benchmarkOptions(
          { label: "valid", worktree: valid },
          [{ label: "no-build", worktree: noBuild }],
          path.join(directory, "build-output"),
        ),
      ),
      /no-build.*dist\/cli\.js/iu,
    );
    await assert.rejects(fs.access(gitOutput));
  });
});

test("captures clean and untracked-dirty Git state with deterministic CLI digests", async () => {
  await withTempDirectory(async (directory) => {
    const clean = await createProvenanceVariant(directory, "clean");
    const dirty = await createProvenanceVariant(directory, "dirty");
    await fs.writeFile(path.join(dirty, "untracked.txt"), "dirty fixture\n", "utf8");
    const outputDirectory = path.join(directory, "output");

    const report = await runBenchmark(
      benchmarkOptions(
        { label: "clean", worktree: clean },
        [{ label: "dirty", worktree: dirty }],
        outputDirectory,
      ),
    );

    assert.equal(report.schemaVersion, 2);
    assert.deepEqual(
      report.variants.map((variant) => ({
        label: variant.label,
        gitDirty: variant.gitDirty,
        cliSha256: variant.cliSha256,
      })),
      [
        {
          label: "clean",
          gitDirty: false,
          cliSha256: "6c9ec574742ee375343b27c1e7fc363e10791301256fb18ee7f534f6a16a05f4",
        },
        {
          label: "dirty",
          gitDirty: true,
          cliSha256: "6c9ec574742ee375343b27c1e7fc363e10791301256fb18ee7f534f6a16a05f4",
        },
      ],
    );

    const paths = await writeBenchmarkReport(report, outputDirectory);
    const markdown = await fs.readFile(paths.markdownPath, "utf8");
    assert.match(markdown, /\| Label \| SHA \| Dirty \| CLI SHA-256 \| Worktree \|/u);
    assert.match(
      markdown,
      /\| clean \| [0-9a-f]{40} \| no \| 6c9ec574742ee375343b27c1e7fc363e10791301256fb18ee7f534f6a16a05f4 \|/u,
    );
    assert.match(
      markdown,
      /\| dirty \| [0-9a-f]{40} \| yes \| 6c9ec574742ee375343b27c1e7fc363e10791301256fb18ee7f534f6a16a05f4 \|/u,
    );
  });
});

test("fails before invoking a variant whose validated CLI digest changed", async () => {
  await withTempDirectory(async (directory) => {
    const candidate = await createFakeVariant(directory, "candidate");
    const candidateCliPath = path.join(candidate, "dist", "cli.js");
    const baseline = await createFakeVariant(directory, "baseline", {
      mutation: {
        contents: fakeCliSource("candidate-mutated", {}),
        invocation: 1,
        path: candidateCliPath,
      },
    });

    await assert.rejects(
      runBenchmark(
        benchmarkOptions(
          { label: "baseline", worktree: baseline },
          [{ label: "candidate", worktree: candidate }],
          path.join(directory, "output"),
        ),
      ),
      /candidate.*CLI.*SHA-256.*changed after validation/iu,
    );
    await assert.rejects(fs.access(path.join(candidate, "dist", "invocations.txt")));
  });
});

test("fails report construction when a measured CLI mutates during its final invocation", async () => {
  await withTempDirectory(async (directory) => {
    const baseline = await createFakeVariant(directory, "baseline");
    const candidateCliPath = path.join(directory, "candidate", "dist", "cli.js");
    const candidate = await createFakeVariant(directory, "candidate", {
      mutation: {
        contents: fakeCliSource("candidate-mutated", {}),
        invocation: 3,
        path: candidateCliPath,
      },
    });

    await assert.rejects(
      runBenchmark(
        benchmarkOptions(
          { label: "baseline", worktree: baseline },
          [{ label: "candidate", worktree: candidate }],
          path.join(directory, "output"),
        ),
      ),
      /candidate.*CLI.*SHA-256.*changed after validation/iu,
    );
  });
});

test("rejects a variant when Git status cannot be read", async () => {
  await withTempDirectory(async (directory) => {
    const valid = await createProvenanceVariant(directory, "valid");
    const invalidStatus = await createProvenanceVariant(directory, "invalid-status");
    await fs.writeFile(path.join(invalidStatus, ".git", "index"), "broken index\n", "utf8");
    const outputDirectory = path.join(directory, "output");

    await assert.rejects(
      runBenchmark(
        benchmarkOptions(
          { label: "valid", worktree: valid },
          [{ label: "invalid-status", worktree: invalidStatus }],
          outputDirectory,
        ),
      ),
      /invalid-status.*Git status/iu,
    );
    await assert.rejects(fs.access(outputDirectory));
  });
});

test("reports preflight and measured failures with label, scenario, and stderr tail", async () => {
  await withTempDirectory(async (directory) => {
    const success = await createFakeVariant(directory, "success");
    const preflightFailure = await createFakeVariant(directory, "preflight-failure", {
      behavior: "always-fail",
      stderrMarker: "preflight stderr marker",
    });
    await assert.rejects(
      runBenchmark(
        benchmarkOptions(
          { label: "success", worktree: success },
          [{ label: "preflight-failure", worktree: preflightFailure }],
          path.join(directory, "preflight-output"),
        ),
      ),
      /preflight-failure.*version.*preflight stderr marker/isu,
    );

    const measuredFailure = await createFakeVariant(directory, "measured-failure", {
      behavior: "fail-after-preflight",
      stderrMarker: "measured stderr marker",
    });
    await assert.rejects(
      runBenchmark(
        benchmarkOptions(
          { label: "success", worktree: success },
          [{ label: "measured-failure", worktree: measuredFailure }],
          path.join(directory, "measured-output"),
        ),
      ),
      /measured-failure.*version.*measured stderr marker/isu,
    );
  });
});

test("alternates adjacent pair order independently for every candidate", async () => {
  await withTempDirectory(async (directory) => {
    const logPath = path.join(directory, "order.ndjson");
    const baseline = await createFakeVariant(directory, "baseline", { logPath });
    const first = await createFakeVariant(directory, "first", { logPath });
    const second = await createFakeVariant(directory, "second", { logPath });

    const report = await runBenchmark(
      benchmarkOptions(
        { label: "baseline", worktree: baseline },
        [
          { label: "first", worktree: first },
          { label: "second", worktree: second },
        ],
        path.join(directory, "output"),
        { samplesOverride: 2 },
      ),
    );

    const records = await readInvocationRecords(logPath);
    const labels = records.map((record) => record.label);
    assert.deepEqual(labels.slice(0, 3), ["baseline", "first", "second"]);
    assert.deepEqual(labels.slice(3, 11), [
      "baseline",
      "first",
      "first",
      "baseline",
      "baseline",
      "second",
      "second",
      "baseline",
    ]);
    const firstComparison = report.scenarios[0]?.comparisons[0];
    const secondComparison = report.scenarios[0]?.comparisons[1];
    assert.equal(firstComparison?.pairedSamples[1]?.order, "candidate-first");
    assert.equal(secondComparison?.pairedSamples[1]?.order, "candidate-first");
    assert.notDeepEqual(
      firstComparison?.pairedSamples.map((sample) => sample.baselineMs),
      secondComparison?.pairedSamples.map((sample) => sample.baselineMs),
    );
  });
});

test("keeps duration identity when the candidate runs first", async () => {
  await withTempDirectory(async (directory) => {
    const baseline = await createFakeVariant(directory, "slow-baseline", { delayMs: 120 });
    const candidate = await createFakeVariant(directory, "fast-candidate");
    const report = await runBenchmark(
      benchmarkOptions(
        { label: "slow-baseline", worktree: baseline },
        [{ label: "fast-candidate", worktree: candidate }],
        path.join(directory, "output"),
        { samplesOverride: 2 },
      ),
    );

    const samples = report.scenarios[0]?.comparisons[0]?.pairedSamples;
    assert.equal(samples?.[1]?.order, "candidate-first");
    assert.ok((samples?.[0]?.baselineMs ?? 0) > (samples?.[0]?.candidateMs ?? 0) + 50);
    assert.ok((samples?.[1]?.baselineMs ?? 0) > (samples?.[1]?.candidateMs ?? 0) + 50);
  });
});

test("preflights every scenario before any warmup starts", async () => {
  await withTempDirectory(async (directory) => {
    const logPath = path.join(directory, "preflight-order.ndjson");
    const baseline = await createFakeVariant(directory, "baseline", { logPath });
    const candidate = await createFakeVariant(directory, "candidate", { logPath });
    await runBenchmark(
      benchmarkOptions(
        { label: "baseline", worktree: baseline },
        [{ label: "candidate", worktree: candidate }],
        path.join(directory, "output"),
        { scenarios: ["version", "help"], warmupsOverride: 1 },
      ),
    );

    const records = await readInvocationRecords(logPath);
    assert.deepEqual(
      records.slice(0, 4).map((record) => [record.label, record.args]),
      [
        ["baseline", ["--version"]],
        ["candidate", ["--version"]],
        ["baseline", ["--help"]],
        ["candidate", ["--help"]],
      ],
    );
    assert.deepEqual(
      records.slice(4, 6).map((record) => [record.label, record.args]),
      [
        ["baseline", ["--version"]],
        ["candidate", ["--version"]],
      ],
    );
  });
});

test("agent scenarios fail closed without an identity-tracked descendant", async (context) => {
  if (!(await canEnumerateProcesses())) {
    context.skip("process enumeration is unavailable");
    return;
  }
  await withTempDirectory(async (directory) => {
    const baseline = await createFakeVariant(directory, "baseline", { spawnAgentChild: false });
    const candidate = await createFakeVariant(directory, "candidate", { spawnAgentChild: false });

    await assert.rejects(
      runBenchmark(
        benchmarkOptions(
          { label: "baseline", worktree: baseline },
          [{ label: "candidate", worktree: candidate }],
          path.join(directory, "output"),
          { scenarios: ["exec"] },
        ),
      ),
      /identity-tracked descendant/iu,
    );
  });
});

test("produces versioned JSON and Markdown with raw samples and separate diagnostics", async () => {
  await withTempDirectory(async (directory) => {
    const outputDirectory = path.join(directory, "output");
    const logPath = path.join(directory, "runs.ndjson");
    const baseline = await createFakeVariant(directory, "baseline", { logPath });
    const candidate = await createFakeVariant(directory, "candidate", { logPath });
    const poisonedMetricsPath = path.join(directory, "poisoned-parent-metrics.ndjson");
    const originalMetricsPath = process.env.ACPX_PERF_METRICS_FILE;
    process.env.ACPX_PERF_METRICS_FILE = poisonedMetricsPath;
    let report;
    try {
      report = await runBenchmark(
        benchmarkOptions(
          { label: "baseline", worktree: baseline },
          [{ label: "candidate", worktree: candidate }],
          outputDirectory,
          { scenarios: ["exec"] },
        ),
      );
    } finally {
      if (originalMetricsPath === undefined) {
        delete process.env.ACPX_PERF_METRICS_FILE;
      } else {
        process.env.ACPX_PERF_METRICS_FILE = originalMetricsPath;
      }
    }

    assert.equal(report.schemaVersion, 2);
    assert.equal(report.scenarios[0]?.comparisons[0]?.pairedSamples.length, 1);
    assert.equal(report.scenarios[0]?.comparisons[0]?.pairedSamples[0]?.order, "baseline-first");
    assert.ok((report.scenarios[0]?.comparisons[0]?.pairedSamples[0]?.baselineMs ?? 0) > 0);
    assert.ok((report.scenarios[0]?.comparisons[0]?.pairedSamples[0]?.candidateMs ?? 0) > 0);
    assert.equal(report.scenarios[0]?.diagnostics.length, 2);
    assert.equal(report.scenarios[0]?.diagnostics[0]?.trace.capture.state, "available");
    assert.equal(report.scenarios[0]?.diagnostics[0]?.trace.preAgent.state, "available");
    assert.equal(report.scenarios[0]?.diagnostics[0]?.internalMetrics.state, "available");

    const records = await readInvocationRecords(logPath);
    assert.deepEqual(
      records.slice(0, 4).map((record) => record.metrics),
      [false, false, false, false],
    );
    assert.deepEqual(
      records.slice(4).map((record) => record.metrics),
      [true, true],
    );
    assert.equal(new Set(records.map((record) => record.home)).size, records.length);
    assert.equal(new Set(records.map((record) => record.cwd)).size, records.length);
    assert.ok(records.every((record) => record.home.includes("home [isolated]")));
    assert.ok(records.every((record) => record.cwd.includes("cwd & workspace")));
    assert.ok(records.every((record) => record.userprofile === record.home));
    await assert.rejects(fs.access(poisonedMetricsPath));

    const paths = await writeBenchmarkReport(report, outputDirectory);
    const json = await fs.readFile(paths.jsonPath, "utf8");
    const markdown = await fs.readFile(paths.markdownPath, "utf8");
    assert.match(json, /"schemaVersion": 2/u);
    assert.match(json, /"pairedSamples": \[/u);
    assert.match(markdown, /# ACPX benchmark report/u);
    assert.match(markdown, /### candidate vs baseline/u);
    assert.match(markdown, /Paired samples: 1/u);
    await assert.rejects(writeBenchmarkReport(report, outputDirectory), /results\.json.*exists/iu);
  });
});

test("refuses existing output before invoking a benchmark CLI", async () => {
  await withTempDirectory(async (directory) => {
    const logPath = path.join(directory, "invocations.ndjson");
    const baseline = await createFakeVariant(directory, "baseline", { logPath });
    const candidate = await createFakeVariant(directory, "candidate", { logPath });
    const outputDirectory = path.join(directory, "output");
    await fs.mkdir(outputDirectory);
    await fs.writeFile(path.join(outputDirectory, "results.json"), "existing\n", "utf8");

    await assert.rejects(
      runBenchmark(
        benchmarkOptions(
          { label: "baseline", worktree: baseline },
          [{ label: "candidate", worktree: candidate }],
          outputDirectory,
        ),
      ),
      /results\.json.*exists/iu,
    );
    await assert.rejects(fs.access(logPath));
  });
});

test("publication races leave no partial result or temporary lock files", async () => {
  await withTempDirectory(async (directory) => {
    const outputDirectory = path.join(directory, "output");
    const baseline = await createFakeVariant(directory, "baseline");
    const candidate = await createFakeVariant(directory, "candidate");
    const report = await runBenchmark(
      benchmarkOptions(
        { label: "baseline", worktree: baseline },
        [{ label: "candidate", worktree: candidate }],
        outputDirectory,
      ),
    );
    const racedMarkdown = path.join(outputDirectory, "results.md");

    await assert.rejects(
      writeBenchmarkReport(report, outputDirectory, {
        beforeMarkdownPublish: async ({ markdownPath }) => {
          assert.equal(markdownPath, racedMarkdown);
          await fs.access(path.join(outputDirectory, "results.json"));
          await fs.writeFile(markdownPath, "raced writer\n", {
            encoding: "utf8",
            flag: "wx",
          });
        },
      }),
      /results\.md.*exists/iu,
    );
    await assert.rejects(fs.access(path.join(outputDirectory, "results.json")));
    assert.equal(await fs.readFile(racedMarkdown, "utf8"), "raced writer\n");
    const controlFiles = (await fs.readdir(outputDirectory)).filter(
      (name) => name.endsWith(".tmp") || name.endsWith(".lock"),
    );
    assert.deepEqual(controlFiles, []);
  });
});

test(
  "successful root exit cleans up an identity-tracked detached descendant",
  { skip: process.platform === "win32", timeout: 5_000 },
  async (context) => {
    if (!(await canEnumerateProcesses())) {
      context.skip("process enumeration is unavailable");
      return;
    }
    await withTempDirectory(async (directory) => {
      const pidPath = path.join(directory, "pids.json");
      const heartbeatPath = path.join(directory, "heartbeat.txt");
      const grandchildSource = [
        'import fs from "node:fs";',
        "const heartbeatPath = process.argv[1];",
        'const beat = () => fs.writeFileSync(heartbeatPath, String(Date.now()), "utf8");',
        "beat();",
        'process.send?.("ready");',
        "process.disconnect();",
        "setInterval(beat, 10);",
      ].join("\n");
      const rootSource = [
        'import { spawn } from "node:child_process";',
        'import fs from "node:fs";',
        "const pidPath = process.argv[1];",
        "const heartbeatPath = process.argv[2];",
        `const grandchild = spawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(grandchildSource)}, heartbeatPath], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });`,
        'grandchild.once("message", () => {',
        "  fs.writeFileSync(pidPath, JSON.stringify({ rootPid: process.pid, grandchildPid: grandchild.pid }));",
        "  grandchild.unref();",
        "  setTimeout(() => process.exit(0), 150);",
        "});",
      ].join("\n");
      const child = spawn(
        process.execPath,
        ["--input-type=module", "-e", rootSource, pidPath, heartbeatPath],
        {
          detached: process.platform !== "win32",
          stdio: "ignore",
          windowsHide: true,
        },
      );
      const rootPid = child.pid;
      assert.ok(rootPid !== undefined);
      let grandchildPid: number | undefined;

      try {
        const resultPromise = waitForBenchmarkChild(child, {
          timeoutMs: 2_000,
          termGraceMs: 50,
          killGraceMs: 500,
          requireTrackedDescendant: true,
        });
        const fixturePids = await waitForPidFile(pidPath);
        assert.equal(fixturePids[0], rootPid);
        const fixtureGrandchildPid = fixturePids[1];
        grandchildPid = fixtureGrandchildPid;
        const result = await resultPromise;
        assert.equal(result.code, 0);
        assert.equal(result.timedOut, false);
        await waitForProcessExit(rootPid);
        await assertHeartbeatStopped(heartbeatPath);
      } finally {
        killProcessTreeFixtureBestEffort(rootPid, grandchildPid);
      }
    });
  },
);

test(
  "normal root exit fails closed when enumeration misses an escaped descendant",
  { skip: process.platform === "win32", timeout: 5_000 },
  async () => {
    await withTempDirectory(async (directory) => {
      const fakeBin = path.join(directory, "fake-bin");
      const psPath = path.join(fakeBin, "ps");
      const pidPath = path.join(directory, "pids.json");
      const heartbeatPath = path.join(directory, "heartbeat.txt");
      const originalPath = process.env.PATH;
      await fs.mkdir(fakeBin);
      await fs.writeFile(psPath, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      const grandchildSource = [
        'import fs from "node:fs";',
        "const heartbeatPath = process.argv[1];",
        'const beat = () => fs.writeFileSync(heartbeatPath, String(Date.now()), "utf8");',
        "beat();",
        'process.send?.("ready");',
        "process.disconnect();",
        "setInterval(beat, 10);",
      ].join("\n");
      const rootSource = [
        'import { spawn } from "node:child_process";',
        'import fs from "node:fs";',
        "const pidPath = process.argv[1];",
        "const heartbeatPath = process.argv[2];",
        `const grandchild = spawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(grandchildSource)}, heartbeatPath], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });`,
        'grandchild.once("message", () => {',
        "  fs.writeFileSync(pidPath, JSON.stringify({ rootPid: process.pid, grandchildPid: grandchild.pid }));",
        "  grandchild.unref();",
        "  process.exit(0);",
        "});",
      ].join("\n");
      process.env.PATH = `${fakeBin}${path.delimiter}${originalPath ?? ""}`;
      const child = spawn(
        process.execPath,
        ["--input-type=module", "-e", rootSource, pidPath, heartbeatPath],
        {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        },
      );
      const rootPid = child.pid;
      assert.ok(rootPid !== undefined);
      let grandchildPid: number | undefined;

      try {
        const resultPromise = waitForBenchmarkChild(child, {
          timeoutMs: 2_000,
          termGraceMs: 50,
          killGraceMs: 500,
        });
        const fixturePids = await waitForPidFile(pidPath);
        grandchildPid = fixturePids[1];
        await assert.rejects(resultPromise, /enumeration.*ownership|ownership.*enumeration/iu);
        await assertHeartbeatContinues(heartbeatPath);
      } finally {
        process.env.PATH = originalPath;
        killProcessTreeFixtureBestEffort(rootPid, grandchildPid);
      }
    });
  },
);

test(
  "bounded timeout terminates an ignoring child and its grandchild",
  { timeout: 5_000 },
  async () => {
    await withTempDirectory(async (directory) => {
      const pidPath = path.join(directory, "pids.json");
      const grandchildSource = 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);';
      const rootSource = [
        'import { spawn } from "node:child_process";',
        'import fs from "node:fs";',
        "const pidPath = process.argv[1];",
        `const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildSource)}], { stdio: "ignore" });`,
        "fs.writeFileSync(pidPath, JSON.stringify({ rootPid: process.pid, grandchildPid: grandchild.pid }));",
        'process.on("SIGTERM", () => {});',
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const child = spawn(process.execPath, ["--input-type=module", "-e", rootSource, pidPath], {
        detached: process.platform !== "win32",
        stdio: "ignore",
        windowsHide: true,
      });
      const rootPid = child.pid;
      assert.ok(rootPid !== undefined);
      let grandchildPid: number | undefined;

      try {
        const fixturePids = await waitForPidFile(pidPath);
        assert.equal(fixturePids[0], rootPid);
        const fixtureGrandchildPid = fixturePids[1];
        grandchildPid = fixtureGrandchildPid;
        const startedAt = performance.now();
        const result = await waitForBenchmarkChild(child, {
          timeoutMs: 25,
          termGraceMs: 50,
          killGraceMs: 500,
        });
        assert.equal(result.timedOut, true);
        assert.ok(performance.now() - startedAt < 3_000);
        await waitForProcessExit(rootPid);
        await waitForProcessExit(fixtureGrandchildPid);
      } finally {
        killProcessTreeFixtureBestEffort(rootPid, grandchildPid);
      }
    });
  },
);
