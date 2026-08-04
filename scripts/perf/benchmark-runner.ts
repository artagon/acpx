#!/usr/bin/env node

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  beginProcessTreeTracking,
  createManagedProcessTree,
  isProcessTreeEnumerationHealthy,
  signalProcessTree,
  waitForProcessTreeExit,
  type ManagedProcessTree,
} from "../../src/acp/process-tree.js";
import type { BenchmarkTraceEvent, BenchmarkTraceEventName } from "./benchmark-agent.js";
import {
  BENCHMARK_SCHEMA_VERSION,
  analyzeEagerGraph,
  calculatePairedDelta,
  createPairOrder,
  parseVariantSpec,
  renderBenchmarkMarkdown,
  summarizeSamples,
  type BenchmarkEnvironment,
  type BenchmarkReport,
  type BenchmarkScenario,
  type BenchmarkVariant,
  type CandidateComparison,
  type InternalMetricSummary,
  type InternalMetricsSupport,
  type LifecycleTraceSummary,
  type PairedSample,
  type ScenarioConfiguration,
  type ScenarioName,
  type StageTiming,
  type TraceCapture,
  type VariantDiagnostics,
  type VariantSpec,
} from "./benchmark-core.js";
import { runBenchmarkPair, type BenchmarkEngineResult } from "./benchmark-engine.js";

export type BenchmarkOptions = Readonly<{
  baseline: VariantSpec;
  candidates: readonly VariantSpec[];
  scenarios: readonly ScenarioName[];
  samplesOverride?: number;
  warmupsOverride?: number;
  seed: number;
  outputDirectory?: string;
}>;

export type BenchmarkScenarioDefinition = Readonly<{
  args: readonly string[];
  command: string;
  configuration: ScenarioConfiguration;
  usesAgent: boolean;
  workloadEndEvent: BenchmarkTraceEventName | null;
}>;

type ValidatedVariant = Readonly<{
  label: string;
  worktree: string;
  cliPath: string;
  gitSha: string;
  gitDirty: boolean;
  cliSha256: string;
}>;

type RunPhase = "diagnostic" | "measured" | "preflight" | "warmup";

type DiagnosticPaths = Readonly<{
  tracePath?: string;
  metricsPath: string;
}>;

type CliRunResult = Readonly<{
  durationMs: number;
  spawnTimestampMs: number;
  closeTimestampMs: number;
}>;

export type BenchmarkChildResult = Readonly<{
  code: number | null;
  signal: string | null;
  stderr: string;
  closeTimestampMs: number;
  spawnError: Error | null;
  timedOut: boolean;
}>;

export type BenchmarkProcessTimeouts = Readonly<{
  timeoutMs: number;
  termGraceMs: number;
  killGraceMs: number;
  onTrackedDescendant?: () => void;
  rootCreatedAfterMs?: number;
  requireTrackedDescendant?: boolean;
}>;

type OutputReservation = Readonly<{
  directory: string;
  lockPath: string;
  token: string;
}>;

type ReportPublicationBoundary = Readonly<{
  beforeMarkdownPublish?: (paths: Readonly<{ markdownPath: string }>) => Promise<void>;
}>;

type CapturedProcessResult = Readonly<{
  code: number | null;
  stderr: string;
  stdout: string;
  spawnError: Error | null;
}>;

const DEFAULT_SEED = 2_886_672_422;
const BOOTSTRAP_RESAMPLES = 10_000;
const STDERR_TAIL_LENGTH = 4_096;
const RUN_TIMEOUT_MS = 30_000;
const RUN_TERM_GRACE_MS = 500;
const RUN_KILL_GRACE_MS = 1_000;
const CHILD_CLOSE_GRACE_MS = 100;
const OUTPUT_LOCK_FILENAME = ".benchmark-results.lock";
export const DEFAULT_SCENARIO_ORDER: readonly ScenarioName[] = Object.freeze([
  "version",
  "help",
  "local-sessions",
  "agent-sessions",
  "exec",
]);

const SCENARIO_DEFINITIONS: Readonly<Record<ScenarioName, BenchmarkScenarioDefinition>> = {
  version: {
    args: ["--version"],
    command: "acpx --version",
    configuration: { samples: 100, warmups: 15 },
    usesAgent: false,
    workloadEndEvent: null,
  },
  help: {
    args: ["--help"],
    command: "acpx --help",
    configuration: { samples: 80, warmups: 12 },
    usesAgent: false,
    workloadEndEvent: null,
  },
  "local-sessions": {
    args: ["--format", "quiet", "benchmark", "sessions", "list", "--local"],
    command: "acpx --format quiet benchmark sessions list --local",
    configuration: { samples: 50, warmups: 8 },
    usesAgent: false,
    workloadEndEvent: null,
  },
  "agent-sessions": {
    args: ["--format", "quiet", "benchmark", "sessions", "list"],
    command: "acpx --format quiet benchmark sessions list",
    configuration: { samples: 25, warmups: 5 },
    usesAgent: true,
    workloadEndEvent: "agent.session_list.end",
  },
  exec: {
    args: ["--format", "quiet", "benchmark", "exec", "benchmark prompt"],
    command: "acpx --format quiet benchmark exec 'benchmark prompt'",
    configuration: { samples: 25, warmups: 5 },
    usesAgent: true,
    workloadEndEvent: "agent.prompt.end",
  },
};

export function benchmarkScenarioDefinition(scenario: ScenarioName): BenchmarkScenarioDefinition {
  const definition = SCENARIO_DEFINITIONS[scenario];
  return {
    ...definition,
    args: [...definition.args],
    configuration: { ...definition.configuration },
  };
}

export function assertBenchmarkPlatform(platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") {
    throw new Error(
      "Reusable CLI benchmark execution requires POSIX process groups; Windows is not supported.",
    );
  }
}

export function parseBenchmarkArgs(argv: readonly string[]): BenchmarkOptions {
  const { values } = parseArgs({
    args: normalizeBenchmarkArgv(argv),
    allowPositionals: false,
    strict: true,
    options: {
      baseline: { type: "string" },
      candidate: { type: "string", multiple: true },
      scenario: { type: "string", multiple: true },
      samples: { type: "string" },
      warmups: { type: "string" },
      seed: { type: "string" },
      output: { type: "string" },
    },
  });

  if (values.baseline === undefined) {
    throw new Error("--baseline is required.");
  }
  if (values.candidate === undefined || values.candidate.length === 0) {
    throw new Error("At least one --candidate is required.");
  }

  const baseline = resolveVariant(parseVariantSpec(values.baseline, "--baseline"));
  const candidates = values.candidate.map((value) =>
    resolveVariant(parseVariantSpec(value, "--candidate")),
  );
  validateUniqueLabels(baseline, candidates);
  const scenarios = parseScenarioNames(values.scenario);
  const samplesOverride = parseOptionalInteger(values.samples, "--samples", false);
  const warmupsOverride = parseOptionalInteger(values.warmups, "--warmups", true);
  const seed = parseSeed(values.seed);

  return {
    baseline,
    candidates,
    scenarios,
    seed,
    ...(samplesOverride === undefined ? {} : { samplesOverride }),
    ...(warmupsOverride === undefined ? {} : { warmupsOverride }),
    ...(values.output === undefined ? {} : { outputDirectory: path.resolve(values.output) }),
  };
}

function normalizeBenchmarkArgv(argv: readonly string[]): string[] {
  return argv[0] === "--" ? argv.slice(1) : [...argv];
}

export async function runBenchmark(options: BenchmarkOptions): Promise<BenchmarkReport> {
  assertBenchmarkPlatform();
  const normalized = normalizeOptions(options);
  const variants = await validateVariants(normalized.baseline, normalized.candidates);
  const outputDirectory = normalized.outputDirectory ?? defaultOutputDirectory();
  const reservation = await reserveOutput(outputDirectory);
  try {
    return await executeBenchmark(normalized, variants, outputDirectory);
  } finally {
    await releaseOutput(reservation);
  }
}

export async function writeBenchmarkReport(
  report: BenchmarkReport,
  outputDirectory: string,
  publicationBoundary: ReportPublicationBoundary = {},
): Promise<Readonly<{ jsonPath: string; markdownPath: string }>> {
  const resolvedOutput = path.resolve(outputDirectory);
  const reservation = await reserveOutput(resolvedOutput);
  try {
    return await writeReservedBenchmarkReport(report, reservation, publicationBoundary);
  } finally {
    await releaseOutput(reservation);
  }
}

async function executeBenchmark(
  options: BenchmarkOptions,
  variants: readonly ValidatedVariant[],
  outputDirectory: string,
): Promise<BenchmarkReport> {
  await preflightScenarios(variants, options.scenarios);
  const scenarios: BenchmarkScenario[] = [];
  for (const scenarioName of options.scenarios) {
    scenarios.push(
      await runScenario(scenarioName, variants[0], variants.slice(1), options, outputDirectory),
    );
  }
  const eagerGraphs = variants.map((variant) => ({
    variantLabel: variant.label,
    summary: analyzeEagerGraph(variant.cliPath),
  }));
  await assertValidatedCliDigests(variants);

  return {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    methodology: {
      pairing: "alternating",
      bootstrapSeed: options.seed,
      bootstrapResamples: BOOTSTRAP_RESAMPLES,
    },
    environment: benchmarkEnvironment(),
    variants: variants.map(toBenchmarkVariant),
    eagerGraphs,
    scenarios,
  };
}

async function writeReservedBenchmarkReport(
  report: BenchmarkReport,
  reservation: OutputReservation,
  publicationBoundary: ReportPublicationBoundary = {},
): Promise<Readonly<{ jsonPath: string; markdownPath: string }>> {
  const jsonPath = path.join(reservation.directory, "results.json");
  const markdownPath = path.join(reservation.directory, "results.md");
  const jsonTempPath = temporaryReportPath(reservation.directory, "results.json");
  const markdownTempPath = temporaryReportPath(reservation.directory, "results.md");
  let jsonPublished = false;
  let markdownPublished = false;
  try {
    await fs.writeFile(jsonTempPath, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await fs.writeFile(markdownTempPath, renderBenchmarkMarkdown(report), {
      encoding: "utf8",
      flag: "wx",
    });
    await publishExclusive(jsonTempPath, jsonPath);
    jsonPublished = true;
    await publicationBoundary.beforeMarkdownPublish?.({ markdownPath });
    await publishExclusive(markdownTempPath, markdownPath);
    markdownPublished = true;
    return { jsonPath, markdownPath };
  } catch (error: unknown) {
    await removePublishedReports([
      ...(jsonPublished ? [jsonPath] : []),
      ...(markdownPublished ? [markdownPath] : []),
    ]);
    throw error;
  } finally {
    await removeTemporaryReports([jsonTempPath, markdownTempPath]);
  }
}

function normalizeOptions(options: BenchmarkOptions): BenchmarkOptions {
  const baseline = resolveVariant(options.baseline);
  const candidates = options.candidates.map(resolveVariant);
  if (candidates.length === 0) {
    throw new Error("At least one candidate is required.");
  }
  validateUniqueLabels(baseline, candidates);
  if (options.scenarios.length === 0) {
    throw new Error("At least one scenario is required.");
  }
  for (const scenario of options.scenarios) {
    if (!isScenarioName(scenario)) {
      throw new Error(`Invalid scenario: ${String(scenario)}`);
    }
  }
  validateOptionalCount(options.samplesOverride, "samples", false);
  validateOptionalCount(options.warmupsOverride, "warmups", true);
  validateSeed(options.seed);
  return {
    baseline,
    candidates,
    scenarios: [...options.scenarios],
    seed: options.seed,
    ...(options.samplesOverride === undefined ? {} : { samplesOverride: options.samplesOverride }),
    ...(options.warmupsOverride === undefined ? {} : { warmupsOverride: options.warmupsOverride }),
    ...(options.outputDirectory === undefined
      ? {}
      : { outputDirectory: path.resolve(options.outputDirectory) }),
  };
}

function resolveVariant(variant: VariantSpec): VariantSpec {
  if (variant.label.trim().length === 0) {
    throw new Error("Variant labels must not be empty.");
  }
  return { label: variant.label, worktree: path.resolve(variant.worktree) };
}

function validateUniqueLabels(baseline: VariantSpec, candidates: readonly VariantSpec[]): void {
  const labels = new Set<string>();
  for (const variant of [baseline, ...candidates]) {
    if (labels.has(variant.label)) {
      throw new Error(`Variant labels must be unique; duplicate label: ${variant.label}`);
    }
    labels.add(variant.label);
  }
}

function parseScenarioNames(values: readonly string[] | undefined): readonly ScenarioName[] {
  if (values === undefined || values.length === 0) {
    return DEFAULT_SCENARIO_ORDER;
  }
  return values.map((value) => {
    if (!isScenarioName(value)) {
      throw new Error(`Invalid scenario: ${value}`);
    }
    return value;
  });
}

function isScenarioName(value: unknown): value is ScenarioName {
  return (
    value === "version" ||
    value === "help" ||
    value === "local-sessions" ||
    value === "agent-sessions" ||
    value === "exec"
  );
}

function parseOptionalInteger(
  value: string | undefined,
  optionName: string,
  allowZero: boolean,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!/^\d+$/u.test(value)) {
    throw new Error(`${optionName} must be a ${allowZero ? "nonnegative" : "positive"} integer.`);
  }
  const parsed = Number(value);
  validateCount(parsed, optionName, allowZero);
  return parsed;
}

function validateOptionalCount(
  value: number | undefined,
  description: string,
  allowZero: boolean,
): void {
  if (value !== undefined) {
    validateCount(value, description, allowZero);
  }
}

function validateCount(value: number, description: string, allowZero: boolean): void {
  const validBoundary = allowZero ? value >= 0 : value > 0;
  if (!Number.isSafeInteger(value) || !validBoundary) {
    throw new Error(`${description} must be a ${allowZero ? "nonnegative" : "positive"} integer.`);
  }
}

function parseSeed(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_SEED;
  }
  if (!/^\d+$/u.test(value)) {
    throw new Error("--seed must be an unsigned 32-bit integer.");
  }
  const seed = Number(value);
  validateSeed(seed);
  return seed;
}

function validateSeed(seed: number): void {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new Error("seed must be an unsigned 32-bit integer.");
  }
}

async function validateVariants(
  baseline: VariantSpec,
  candidates: readonly VariantSpec[],
): Promise<readonly ValidatedVariant[]> {
  const variants: ValidatedVariant[] = [];
  for (const variant of [baseline, ...candidates]) {
    variants.push(await validateVariant(variant));
  }
  return variants;
}

async function validateVariant(variant: VariantSpec): Promise<ValidatedVariant> {
  const cliPath = path.join(variant.worktree, "dist", "cli.js");
  if (!(await isFile(cliPath))) {
    throw new Error(`Variant ${variant.label} is missing built CLI dist/cli.js at ${cliPath}.`);
  }

  const gitResult = await runCapturedProcess("git", ["-C", variant.worktree, "rev-parse", "HEAD"]);
  const gitSha = gitResult.stdout.trim();
  if (
    gitResult.spawnError !== null ||
    gitResult.code !== 0 ||
    !/^[0-9a-f]{40,64}$/iu.test(gitSha)
  ) {
    throw new Error(
      `Variant ${variant.label} does not have a resolvable Git HEAD. stderr tail: ${stderrTail(gitResult.stderr || gitResult.spawnError?.message || "no stderr")}`,
    );
  }

  const statusResult = await runCapturedProcess("git", [
    "-C",
    variant.worktree,
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (statusResult.spawnError !== null || statusResult.code !== 0) {
    throw new Error(
      `Variant ${variant.label} Git status failed. stderr tail: ${stderrTail(statusResult.stderr || statusResult.spawnError?.message || "no stderr")}`,
    );
  }

  return {
    label: variant.label,
    worktree: variant.worktree,
    cliPath,
    gitSha,
    gitDirty: statusResult.stdout.length > 0,
    cliSha256: await sha256File(cliPath),
  };
}

async function sha256File(filePath: string): Promise<string> {
  return createHash("sha256")
    .update(await fs.readFile(filePath))
    .digest("hex");
}

async function assertValidatedCliDigests(variants: readonly ValidatedVariant[]): Promise<void> {
  for (const variant of variants) {
    await assertValidatedCliDigest(variant);
  }
}

async function assertValidatedCliDigest(variant: ValidatedVariant): Promise<void> {
  let currentDigest: string;
  try {
    currentDigest = await sha256File(variant.cliPath);
  } catch (error: unknown) {
    throw new Error(
      `Variant ${variant.label} CLI SHA-256 could not be revalidated after validation: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  if (currentDigest !== variant.cliSha256) {
    throw new Error(
      `Variant ${variant.label} CLI SHA-256 changed after validation: expected ${variant.cliSha256}, received ${currentDigest}.`,
    );
  }
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function preflightScenarios(
  variants: readonly ValidatedVariant[],
  scenarios: readonly ScenarioName[],
): Promise<void> {
  for (const scenario of scenarios) {
    for (const variant of variants) {
      await executeCli(variant, scenario, "preflight");
    }
  }
}

async function runScenario(
  scenarioName: ScenarioName,
  baseline: ValidatedVariant,
  candidates: readonly ValidatedVariant[],
  options: BenchmarkOptions,
  outputDirectory: string,
): Promise<BenchmarkScenario> {
  const definition = SCENARIO_DEFINITIONS[scenarioName];
  const configuration = scenarioConfiguration(definition, options);
  const comparisons: CandidateComparison[] = [];

  for (const candidate of candidates) {
    await runWarmups(baseline, candidate, scenarioName, configuration.warmups);
    comparisons.push(
      await runCandidateComparison(
        baseline,
        candidate,
        scenarioName,
        configuration.samples,
        options.seed,
      ),
    );
  }

  const diagnostics = await runScenarioDiagnostics(
    [baseline, ...candidates],
    scenarioName,
    outputDirectory,
  );
  return {
    name: scenarioName,
    command: definition.command,
    configuration,
    comparisons,
    diagnostics,
  };
}

function scenarioConfiguration(
  definition: BenchmarkScenarioDefinition,
  options: BenchmarkOptions,
): ScenarioConfiguration {
  return {
    samples: options.samplesOverride ?? definition.configuration.samples,
    warmups: options.warmupsOverride ?? definition.configuration.warmups,
  };
}

async function runWarmups(
  baseline: ValidatedVariant,
  candidate: ValidatedVariant,
  scenario: ScenarioName,
  count: number,
): Promise<void> {
  for (let warmupIndex = 0; warmupIndex < count; warmupIndex += 1) {
    const order = createPairOrder(baseline, candidate, warmupIndex);
    for (const variant of order) {
      await executeCli(variant, scenario, "warmup");
    }
  }
}

async function runCandidateComparison(
  baseline: ValidatedVariant,
  candidate: ValidatedVariant,
  scenario: ScenarioName,
  samples: number,
  seed: number,
): Promise<CandidateComparison> {
  const pairedSamples: PairedSample[] = [];
  for (let sampleIndex = 0; sampleIndex < samples; sampleIndex += 1) {
    pairedSamples.push(await runMeasuredPair(baseline, candidate, scenario, sampleIndex));
  }

  const baselineSamples = pairedSamples.map((sample) => sample.baselineMs);
  const candidateSamples = pairedSamples.map((sample) => sample.candidateMs);
  return {
    baselineLabel: baseline.label,
    candidateLabel: candidate.label,
    pairedSamples,
    baselineSummary: summarizeSamples(baselineSamples),
    candidateSummary: summarizeSamples(candidateSamples),
    pairedDelta: calculatePairedDelta(candidateSamples, baselineSamples, seed, BOOTSTRAP_RESAMPLES),
  };
}

async function runMeasuredPair(
  baseline: ValidatedVariant,
  candidate: ValidatedVariant,
  scenario: ScenarioName,
  sampleIndex: number,
): Promise<PairedSample> {
  const order = createPairOrder(baseline, candidate, sampleIndex);
  const results = await runBenchmarkPair([
    measuredEngineTask(order[0], scenario),
    measuredEngineTask(order[1], scenario),
  ]);
  const baselineMs = resultForVariant(results, baseline.label);
  const candidateMs = resultForVariant(results, candidate.label);
  return {
    sampleIndex,
    order: sampleIndex % 2 === 0 ? "baseline-first" : "candidate-first",
    baselineMs,
    candidateMs,
  };
}

function measuredEngineTask(variant: ValidatedVariant, scenario: ScenarioName) {
  return {
    name: variant.label,
    execute: async () => (await executeCli(variant, scenario, "measured")).durationMs,
  };
}

function resultForVariant(
  results: readonly [BenchmarkEngineResult, BenchmarkEngineResult],
  label: string,
): number {
  const result = results.find((entry) => entry.name === label);
  if (result === undefined) {
    throw new Error(`Tinybench did not return the measured variant: ${label}`);
  }
  return result.durationMs;
}

async function runScenarioDiagnostics(
  variants: readonly ValidatedVariant[],
  scenario: ScenarioName,
  outputDirectory: string,
): Promise<readonly VariantDiagnostics[]> {
  const diagnostics: VariantDiagnostics[] = [];
  for (const variant of variants) {
    diagnostics.push(await runVariantDiagnostic(variant, scenario, outputDirectory));
  }
  return diagnostics;
}

async function runVariantDiagnostic(
  variant: ValidatedVariant,
  scenario: ScenarioName,
  outputDirectory: string,
): Promise<VariantDiagnostics> {
  const paths = await createDiagnosticPaths(outputDirectory, scenario, variant.label);
  const result = await executeCli(variant, scenario, "diagnostic", paths);
  const definition = SCENARIO_DEFINITIONS[scenario];
  return {
    variantLabel: variant.label,
    trace: await summarizeLifecycleTrace(definition, paths.tracePath, result),
    internalMetrics: await summarizeInternalMetrics(paths.metricsPath),
  };
}

async function createDiagnosticPaths(
  outputDirectory: string,
  scenario: ScenarioName,
  label: string,
): Promise<DiagnosticPaths> {
  const directory = path.join(
    path.resolve(outputDirectory),
    "diagnostics",
    scenario,
    encodeURIComponent(label),
  );
  await fs.mkdir(directory, { recursive: true });
  const suffix = randomUUID();
  const metricsPath = path.join(directory, `metrics-${suffix}.ndjson`);
  return SCENARIO_DEFINITIONS[scenario].usesAgent
    ? { tracePath: path.join(directory, `trace-${suffix}.ndjson`), metricsPath }
    : { metricsPath };
}

async function executeCli(
  variant: ValidatedVariant,
  scenario: ScenarioName,
  phase: RunPhase,
  diagnostics?: DiagnosticPaths,
): Promise<CliRunResult> {
  const runRoot = await fs.mkdtemp(path.join(os.tmpdir(), "acpx benchmark [isolated]-"));
  try {
    const homeDirectory = path.join(runRoot, "home [isolated]");
    const cwd = path.join(runRoot, "cwd & workspace");
    await prepareRunDirectories(homeDirectory, cwd, diagnostics?.tracePath);
    const env = createRunEnvironment(homeDirectory, diagnostics?.metricsPath);
    const definition = SCENARIO_DEFINITIONS[scenario];
    const spawnOptions: SpawnOptions = {
      cwd,
      detached: process.platform !== "win32",
      env,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    };
    await assertValidatedCliDigest(variant);
    const rootCreatedAfterMs = Date.now();
    const spawnStart = performance.now();
    const child = spawn(process.execPath, [variant.cliPath, ...definition.args], spawnOptions);
    const childResult = await waitForBenchmarkChild(child, {
      timeoutMs: RUN_TIMEOUT_MS,
      termGraceMs: RUN_TERM_GRACE_MS,
      killGraceMs: RUN_KILL_GRACE_MS,
      rootCreatedAfterMs,
      requireTrackedDescendant: definition.usesAgent,
    });
    const durationMs = childResult.closeTimestampMs - (performance.timeOrigin + spawnStart);
    assertSuccessfulRun(childResult, variant, scenario, phase);
    return {
      durationMs,
      spawnTimestampMs: performance.timeOrigin + spawnStart,
      closeTimestampMs: childResult.closeTimestampMs,
    };
  } finally {
    await fs.rm(runRoot, { force: true, maxRetries: 3, recursive: true, retryDelay: 50 });
  }
}

async function prepareRunDirectories(
  homeDirectory: string,
  cwd: string,
  tracePath: string | undefined,
): Promise<void> {
  const configDirectory = path.join(homeDirectory, ".acpx");
  await fs.mkdir(configDirectory, { recursive: true });
  await fs.mkdir(cwd, { recursive: true });
  const argv = benchmarkAgentArgv(tracePath);
  await fs.writeFile(
    path.join(configDirectory, "config.json"),
    `${JSON.stringify({ agents: { benchmark: { argv } } })}\n`,
    "utf8",
  );
}

function benchmarkAgentArgv(tracePath: string | undefined): readonly string[] {
  const agentPath = path.resolve("dist-test", "scripts", "perf", "benchmark-agent.js");
  return tracePath === undefined
    ? [process.execPath, agentPath]
    : [process.execPath, agentPath, "--trace-file", tracePath];
}

function createRunEnvironment(
  homeDirectory: string,
  metricsPath: string | undefined,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDirectory,
    USERPROFILE: homeDirectory,
  };
  delete env.ACPX_PERF_METRICS_FILE;
  if (metricsPath !== undefined) {
    env.ACPX_PERF_METRICS_FILE = metricsPath;
  }
  return env;
}

export async function waitForBenchmarkChild(
  child: ChildProcess,
  timeouts: BenchmarkProcessTimeouts = {
    timeoutMs: RUN_TIMEOUT_MS,
    termGraceMs: RUN_TERM_GRACE_MS,
    killGraceMs: RUN_KILL_GRACE_MS,
  },
  platform: NodeJS.Platform = process.platform,
): Promise<BenchmarkChildResult> {
  const processTree = createManagedProcessTree(
    child.pid,
    true,
    platform,
    timeouts.rootCreatedAfterMs,
  );
  let timedOut = false;
  const closeResult = observeChildClose(child, () => timedOut);
  let reportedTrackedDescendant = false;
  let trackedDescendantObserverError: Error | undefined;
  beginProcessTreeTracking(
    processTree,
    () => isChildRunning(child),
    (trackedTree) => {
      if (
        !reportedTrackedDescendant &&
        trackedTree.observedOwnedDescendant &&
        timeouts.onTrackedDescendant
      ) {
        reportedTrackedDescendant = true;
        try {
          timeouts.onTrackedDescendant();
        } catch (error: unknown) {
          trackedDescendantObserverError = new Error(
            `Benchmark tracked-descendant observer failed: ${errorMessage(error)}`,
          );
        }
      }
    },
  );
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ state: "timeout" }>((resolve) => {
    timeoutHandle = setTimeout(() => resolve({ state: "timeout" }), timeouts.timeoutMs);
  });
  const first = await Promise.race([
    closeResult.then((result) => ({ state: "closed" as const, result })),
    timeout,
  ]);
  clearTimeout(timeoutHandle);
  if (first.state === "closed") {
    // Preserve the observed close timestamp for measurement, then clean up any
    // descendants that outlived a normally exited CLI root.
    await cleanupClosedBenchmarkProcessTree(child, processTree, timeouts);
    if (trackedDescendantObserverError) {
      throw trackedDescendantObserverError;
    }
    return first.result;
  }

  timedOut = true;
  await terminateBenchmarkProcessTree(child, processTree, timeouts);
  await assertHealthyProcessEnumeration(processTree);
  if (trackedDescendantObserverError) {
    throw trackedDescendantObserverError;
  }
  const finalResult = await Promise.race([
    closeResult,
    waitMilliseconds(CHILD_CLOSE_GRACE_MS).then(() => undefined),
  ]);
  if (finalResult !== undefined) {
    return finalResult;
  }
  detachChildHandles(child);
  return {
    code: child.exitCode,
    signal: child.signalCode,
    stderr: "",
    closeTimestampMs: performance.timeOrigin + performance.now(),
    spawnError: null,
    timedOut: true,
  };
}

async function cleanupClosedBenchmarkProcessTree(
  child: ChildProcess,
  processTree: ManagedProcessTree,
  timeouts: BenchmarkProcessTimeouts,
): Promise<void> {
  if (processTree.platform === "win32") {
    return;
  }
  await assertHealthyProcessEnumeration(processTree);
  let ownershipError: Error | undefined;
  // For an exited root, the initial signal path waits for any in-flight
  // snapshot and refreshes remembered ownership before this callback runs.
  const exited = await terminateBenchmarkProcessTree(child, processTree, timeouts, () => {
    try {
      assertRequiredTrackedDescendant(processTree, timeouts);
    } catch (error: unknown) {
      ownershipError = error instanceof Error ? error : new Error(String(error));
    }
  });
  await assertHealthyProcessEnumeration(processTree);
  if (ownershipError) {
    throw ownershipError;
  }
  if (!exited) {
    throw new Error("Benchmark CLI identity-tracked process tree survived bounded cleanup.");
  }
}

function assertRequiredTrackedDescendant(
  processTree: ManagedProcessTree,
  timeouts: BenchmarkProcessTimeouts,
): void {
  if (!timeouts.requireTrackedDescendant) {
    return;
  }
  if (processTree.observedOwnedDescendant) {
    return;
  }
  throw new Error(
    "Benchmark agent scenario exited without an identity-tracked descendant; cleanup cannot prove ownership of the expected agent process.",
  );
}

async function assertHealthyProcessEnumeration(processTree: ManagedProcessTree): Promise<void> {
  if (!(await isProcessTreeEnumerationHealthy(processTree))) {
    throw new Error(
      "Benchmark CLI process ownership enumeration was unavailable; cleanup cannot prove that all descendants were found.",
    );
  }
}

function observeChildClose(
  child: ChildProcess,
  timedOut: () => boolean,
): Promise<BenchmarkChildResult> {
  return new Promise<BenchmarkChildResult>((resolve) => {
    let stderr = "";
    let spawnError: Error | null = null;
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = stderrTail(stderr + chunk);
    });
    child.once("error", (error: Error) => {
      spawnError = error;
    });
    child.once("close", (code, signal) => {
      resolve({
        code,
        signal,
        stderr,
        closeTimestampMs: performance.timeOrigin + performance.now(),
        spawnError,
        timedOut: timedOut(),
      });
    });
  });
}

async function terminateBenchmarkProcessTree(
  child: ChildProcess,
  processTree: ManagedProcessTree,
  timeouts: BenchmarkProcessTimeouts,
  afterInitialSignal?: () => void,
): Promise<boolean> {
  const rootRunning = () => isChildRunning(child);
  await signalTreeBestEffort(processTree, rootRunning, "SIGTERM");
  afterInitialSignal?.();
  const exited = await waitForProcessTreeExit(processTree, rootRunning, timeouts.termGraceMs);
  if (exited) {
    return true;
  }
  await signalTreeBestEffort(processTree, rootRunning, "SIGKILL");
  return await waitForProcessTreeExit(processTree, rootRunning, timeouts.killGraceMs, "SIGKILL");
}

async function signalTreeBestEffort(
  processTree: ManagedProcessTree,
  rootRunning: () => boolean,
  signal: "SIGKILL" | "SIGTERM",
): Promise<void> {
  try {
    await signalProcessTree(processTree, rootRunning, signal);
  } catch {
    // Timeout cleanup is best effort, but its waits remain bounded.
  }
}

function isChildRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function detachChildHandles(child: ChildProcess): void {
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
  try {
    child.unref();
  } catch {
    // The child may already be fully detached.
  }
}

function waitMilliseconds(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, Math.max(0, milliseconds));
  });
}

function assertSuccessfulRun(
  result: BenchmarkChildResult,
  variant: ValidatedVariant,
  scenario: ScenarioName,
  phase: RunPhase,
): void {
  if (result.spawnError === null && result.code === 0 && !result.timedOut) {
    return;
  }
  const status = result.timedOut
    ? `timed out after ${RUN_TIMEOUT_MS} ms`
    : (result.spawnError?.message ??
      `exited with code ${String(result.code)} signal ${String(result.signal)}`);
  throw new Error(
    `Benchmark ${phase} failed for ${variant.label}/${scenario}: ${status}. stderr tail: ${stderrTail(result.stderr || "no stderr")}`,
  );
}

async function summarizeLifecycleTrace(
  definition: BenchmarkScenarioDefinition,
  tracePath: string | undefined,
  run: CliRunResult,
): Promise<LifecycleTraceSummary> {
  if (!definition.usesAgent || definition.workloadEndEvent === null) {
    return unavailableLifecycleTrace("scenario does not spawn the benchmark agent");
  }
  if (tracePath === undefined) {
    return unavailableLifecycleTrace("trace capture was not attempted");
  }

  const parsed = await readTraceEvents(tracePath);
  if (parsed.state === "unavailable") {
    return {
      capture: parsed.capture,
      preAgent: unavailableStage(parsed.reason),
      acpActive: unavailableStage(parsed.reason),
      teardown: unavailableStage(parsed.reason),
    };
  }
  return availableLifecycleTrace(parsed.events, tracePath, definition.workloadEndEvent, run);
}

type TraceReadResult =
  | Readonly<{
      state: "available";
      events: readonly BenchmarkTraceEvent[];
    }>
  | Readonly<{
      state: "unavailable";
      capture: TraceCapture;
      reason: string;
    }>;

async function readTraceEvents(tracePath: string): Promise<TraceReadResult> {
  try {
    const contents = await fs.readFile(tracePath, "utf8");
    const events = contents
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map(parseTraceEvent);
    if (events.length === 0) {
      return unavailableTraceRead(tracePath, "trace file contained no events");
    }
    return { state: "available", events };
  } catch (error: unknown) {
    return unavailableTraceRead(tracePath, `unable to read trace: ${errorMessage(error)}`);
  }
}

function parseTraceEvent(line: string): BenchmarkTraceEvent {
  const value: unknown = JSON.parse(line);
  if (typeof value !== "object" || value === null) {
    throw new Error("trace line is not an object");
  }
  const event = Reflect.get(value, "event");
  const pid = Reflect.get(value, "pid");
  const timestampMs = Reflect.get(value, "timestampMs");
  if (
    !isBenchmarkTraceEventName(event) ||
    typeof pid !== "number" ||
    !isFiniteNumber(timestampMs)
  ) {
    throw new Error("trace line has invalid fields");
  }
  return { event, pid, timestampMs };
}

function isBenchmarkTraceEventName(value: unknown): value is BenchmarkTraceEventName {
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

function unavailableTraceRead(tracePath: string, reason: string): TraceReadResult {
  return {
    state: "unavailable",
    capture: { state: "unavailable", tracePath, unavailableReason: reason },
    reason,
  };
}

function availableLifecycleTrace(
  events: readonly BenchmarkTraceEvent[],
  tracePath: string,
  workloadEndEvent: BenchmarkTraceEventName,
  run: CliRunResult,
): LifecycleTraceSummary {
  const processStart = eventTimestamp(events, "agent.process_start");
  const workloadEnd = eventTimestamp(events, workloadEndEvent);
  return {
    capture: { state: "available", tracePath, eventCount: events.length },
    preAgent: stageBetween(run.spawnTimestampMs, processStart, "agent.process_start"),
    acpActive: stageBetween(processStart, workloadEnd, workloadEndEvent),
    teardown: stageBetween(workloadEnd, run.closeTimestampMs, "child close"),
  };
}

function eventTimestamp(
  events: readonly BenchmarkTraceEvent[],
  eventName: BenchmarkTraceEventName,
): number | undefined {
  return events.find((event) => event.event === eventName)?.timestampMs;
}

function stageBetween(
  start: number | undefined,
  end: number | undefined,
  requiredEvent: string,
): StageTiming {
  if (start === undefined || end === undefined) {
    return unavailableStage(`required event missing: ${requiredEvent}`);
  }
  const durationMs = end - start;
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return unavailableStage(`invalid event ordering at ${requiredEvent}`);
  }
  return { state: "available", durationMs };
}

function unavailableLifecycleTrace(reason: string): LifecycleTraceSummary {
  return {
    capture: { state: "unavailable", tracePath: null, unavailableReason: reason },
    preAgent: unavailableStage(reason),
    acpActive: unavailableStage(reason),
    teardown: unavailableStage(reason),
  };
}

function unavailableStage(reason: string): StageTiming {
  return { state: "unavailable", unavailableReason: reason };
}

async function summarizeInternalMetrics(metricsPath: string): Promise<InternalMetricsSupport> {
  try {
    const contents = await fs.readFile(metricsPath, "utf8");
    const summaries = new Map<string, InternalMetricSummary>();
    for (const line of contents.split("\n").filter((entry) => entry.trim().length > 0)) {
      appendMetricRecord(summaries, line);
    }
    return {
      state: "available",
      metricsPath,
      metrics: [...summaries.values()].toSorted((left, right) =>
        left.name.localeCompare(right.name),
      ),
    };
  } catch (error: unknown) {
    return {
      state: "unavailable",
      metricsPath,
      unavailableReason: `unable to read internal metrics: ${errorMessage(error)}`,
    };
  }
}

function appendMetricRecord(summaries: Map<string, InternalMetricSummary>, line: string): void {
  const value: unknown = JSON.parse(line);
  if (typeof value !== "object" || value === null) {
    throw new Error("metrics line is not an object");
  }
  const metrics = Reflect.get(value, "metrics");
  if (typeof metrics !== "object" || metrics === null) {
    return;
  }
  const timings = Reflect.get(metrics, "timings");
  if (typeof timings !== "object" || timings === null) {
    return;
  }
  for (const name of Object.keys(timings)) {
    appendMetricBucket(summaries, name, Reflect.get(timings, name));
  }
}

function appendMetricBucket(
  summaries: Map<string, InternalMetricSummary>,
  name: string,
  value: unknown,
): void {
  if (typeof value !== "object" || value === null) {
    throw new Error(`invalid internal metric: ${name}`);
  }
  const count = Reflect.get(value, "count");
  const totalMs = Reflect.get(value, "totalMs");
  const maxMs = Reflect.get(value, "maxMs");
  if (!isNonnegativeNumber(count) || !isNonnegativeNumber(totalMs) || !isNonnegativeNumber(maxMs)) {
    throw new Error(`invalid internal metric: ${name}`);
  }
  const previous = summaries.get(name);
  summaries.set(name, {
    name,
    count: (previous?.count ?? 0) + count,
    totalMs: (previous?.totalMs ?? 0) + totalMs,
    maxMs: Math.max(previous?.maxMs ?? 0, maxMs),
  });
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonnegativeNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function benchmarkEnvironment(): BenchmarkEnvironment {
  const cpus = os.cpus();
  const [oneMinute = 0, fiveMinutes = 0, fifteenMinutes = 0] = os.loadavg();
  return {
    hostname: os.hostname(),
    osType: os.type(),
    osRelease: os.release(),
    platform: process.platform,
    arch: process.arch,
    nodeExecutable: process.execPath,
    nodeVersion: process.version,
    cpuModel: cpus[0]?.model ?? "unknown",
    cpuCount: cpus.length,
    totalMemoryBytes: os.totalmem(),
    loadAverage: [oneMinute, fiveMinutes, fifteenMinutes],
  };
}

function toBenchmarkVariant(variant: ValidatedVariant): BenchmarkVariant {
  return {
    label: variant.label,
    worktree: variant.worktree,
    gitSha: variant.gitSha,
    gitDirty: variant.gitDirty,
    cliSha256: variant.cliSha256,
  };
}

async function runCapturedProcess(
  command: string,
  args: readonly string[],
): Promise<CapturedProcessResult> {
  return await new Promise<CapturedProcessResult>((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let spawnError: Error | null = null;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = stderrTail(stderr + chunk);
    });
    child.once("error", (error: Error) => {
      spawnError = error;
    });
    child.once("close", (code) => {
      resolve({ code, stderr, stdout, spawnError });
    });
  });
}

async function assertTargetsDoNotExist(targets: readonly string[]): Promise<void> {
  for (const target of targets) {
    try {
      await fs.access(target);
      throw new Error(`Refusing to overwrite existing report: ${target} exists.`);
    } catch (error: unknown) {
      if (!isMissingPathError(error)) {
        throw error;
      }
    }
  }
}

async function reserveOutput(outputDirectory: string): Promise<OutputReservation> {
  const directory = path.resolve(outputDirectory);
  await fs.mkdir(directory, { recursive: true });
  const reservation: OutputReservation = {
    directory,
    lockPath: path.join(directory, OUTPUT_LOCK_FILENAME),
    token: randomUUID(),
  };
  try {
    await fs.writeFile(reservation.lockPath, `${reservation.token}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error: unknown) {
    if (isAlreadyExistsError(error)) {
      throw new Error(`Benchmark output is already reserved: ${reservation.lockPath} exists.`, {
        cause: error,
      });
    }
    throw error;
  }

  try {
    await assertTargetsDoNotExist([
      path.join(directory, "results.json"),
      path.join(directory, "results.md"),
    ]);
    return reservation;
  } catch (error: unknown) {
    await releaseOutput(reservation);
    throw error;
  }
}

async function releaseOutput(reservation: OutputReservation): Promise<void> {
  try {
    const token = (await fs.readFile(reservation.lockPath, "utf8")).trim();
    if (token === reservation.token) {
      await fs.rm(reservation.lockPath, { force: true });
    }
  } catch (error: unknown) {
    if (!isMissingPathError(error)) {
      throw error;
    }
  }
}

async function publishExclusive(tempPath: string, targetPath: string): Promise<void> {
  try {
    await fs.link(tempPath, targetPath);
  } catch (error: unknown) {
    if (isAlreadyExistsError(error)) {
      throw new Error(`Refusing to overwrite existing report: ${targetPath} exists.`, {
        cause: error,
      });
    }
    throw error;
  }
}

async function removePublishedReports(paths: readonly string[]): Promise<void> {
  await Promise.all(paths.map(async (filePath) => await fs.rm(filePath, { force: true })));
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT";
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === "EEXIST";
}

function temporaryReportPath(outputDirectory: string, filename: string): string {
  return path.join(outputDirectory, `.${filename}.${randomUUID()}.tmp`);
}

async function removeTemporaryReports(paths: readonly string[]): Promise<void> {
  await Promise.all(paths.map(async (filePath) => await fs.rm(filePath, { force: true })));
}

function defaultOutputDirectory(): string {
  return path.join(os.tmpdir(), `acpx-benchmark-${randomUUID()}`);
}

function stderrTail(stderr: string): string {
  return stderr.slice(-STDERR_TAIL_LENGTH);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isInvokedEntrypoint(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href;
}

async function runEntrypoint(argv: readonly string[]): Promise<void> {
  const parsed = parseBenchmarkArgs(argv);
  assertBenchmarkPlatform();
  const outputDirectory = parsed.outputDirectory ?? defaultOutputDirectory();
  const normalized = normalizeOptions({ ...parsed, outputDirectory });
  const variants = await validateVariants(normalized.baseline, normalized.candidates);
  const reservation = await reserveOutput(outputDirectory);
  let jsonPath: string;
  try {
    const report = await executeBenchmark(normalized, variants, outputDirectory);
    ({ jsonPath } = await writeReservedBenchmarkReport(report, reservation));
  } finally {
    await releaseOutput(reservation);
  }
  process.stdout.write(`${jsonPath}\n`);
}

if (isInvokedEntrypoint()) {
  void runEntrypoint(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
