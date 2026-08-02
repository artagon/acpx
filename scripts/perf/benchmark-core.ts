import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { gzipSync } from "node:zlib";

export const BENCHMARK_SCHEMA_VERSION = 1;

export type ScenarioName = "version" | "help" | "local-sessions" | "agent-sessions" | "exec";

export type VariantSpec = Readonly<{
  label: string;
  worktree: string;
}>;

export type SampleSummary = Readonly<{
  n: number;
  meanMs: number;
  medianMs: number;
  p95Ms: number;
  stddevMs: number;
  minMs: number;
  maxMs: number;
}>;

export type PairedDelta = Readonly<{
  geometricMeanDeltaPct: number;
  ci95Pct: readonly [number, number];
}>;

export type EagerGraphSummary = Readonly<{
  chunks: number;
  bytes: number;
  gzipBytes: number;
  externalPackages: readonly string[];
  files: readonly string[];
}>;

export type BenchmarkMethodology = Readonly<{
  samplesPerScenario: number;
  warmupSamples: number;
  pairing: "alternating";
  bootstrapSeed: number;
  bootstrapResamples: number;
}>;

export type BenchmarkEnvironment = Readonly<{
  platform: string;
  arch: string;
  nodeVersion: string;
  cpuModel: string;
  cpuCount: number;
  totalMemoryBytes: number;
}>;

export type BenchmarkVariant = Readonly<{
  label: string;
  worktree: string;
  gitSha: string;
}>;

export type BenchmarkEagerGraph = Readonly<{
  variantLabel: string;
  summary: EagerGraphSummary;
}>;

export type BenchmarkVariantSamples = Readonly<{
  variantLabel: string;
  samplesMs: readonly number[];
  summary: SampleSummary;
}>;

export type CandidateComparison = Readonly<{
  baselineLabel: string;
  candidateLabel: string;
  pairedDelta: PairedDelta;
}>;

export type TraceSummary = Readonly<{
  variantLabel: string;
  tracePath: string;
  eventCount: number;
  durationMs: number;
}>;

export type InternalMetricSummary = Readonly<{
  name: string;
  count: number;
  totalMs: number;
  maxMs: number;
}>;

export type InternalMetricsSupport = Readonly<{
  supported: boolean;
  unsupportedReason: string | null;
  metrics: readonly InternalMetricSummary[];
}>;

export type BenchmarkScenario = Readonly<{
  name: ScenarioName;
  command: string;
  variants: readonly BenchmarkVariantSamples[];
  comparison: CandidateComparison;
  traces: readonly TraceSummary[];
  internalMetrics: InternalMetricsSupport;
}>;

export type BenchmarkReport = Readonly<{
  schemaVersion: number;
  methodology: BenchmarkMethodology;
  environment: BenchmarkEnvironment;
  variants: readonly BenchmarkVariant[];
  eagerGraphs: readonly BenchmarkEagerGraph[];
  scenarios: readonly BenchmarkScenario[];
}>;

const DEFAULT_BOOTSTRAP_RESAMPLES = 10_000;
const ZERO_SEED_STATE = 0x6d2b79f5;
const STATIC_IMPORT_PATTERN =
  /(?:^|[\n;])\s*(?:import\s+(?:[^'"\n]+\s+from\s+)?|export\s+(?:[^'"\n]+\s+from\s+)?)["']([^"']+)["']/gu;

export function parseVariantSpec(value: string, optionName: string): VariantSpec {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`Invalid ${optionName} value; expected label=worktree.`);
  }

  return {
    label: value.slice(0, separator),
    worktree: value.slice(separator + 1),
  };
}

export function createPairOrder<T>(baseline: T, candidate: T, sampleIndex: number): readonly [T, T] {
  return sampleIndex % 2 === 0 ? [baseline, candidate] : [candidate, baseline];
}

export function summarizeSamples(values: readonly number[]): SampleSummary {
  validateTimingSamples(values, "timing samples");
  const sorted = values.toSorted((left, right) => left - right);
  const total = values.reduce((sum, value) => sum + value, 0);
  const meanMs = total / values.length;
  const squaredDifferenceTotal = values.reduce(
    (sum, value) => sum + (value - meanMs) ** 2,
    0,
  );
  const middle = values.length / 2;
  const medianMs =
    values.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[Math.floor(middle)];

  return {
    n: values.length,
    meanMs,
    medianMs,
    p95Ms: nearestRank(sorted, 0.95),
    stddevMs: values.length === 1 ? 0 : Math.sqrt(squaredDifferenceTotal / (values.length - 1)),
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
  };
}

export function calculatePairedDelta(
  candidate: readonly number[],
  baseline: readonly number[],
  seed: number,
  resamples = DEFAULT_BOOTSTRAP_RESAMPLES,
): PairedDelta {
  validateTimingSamples(candidate, "candidate samples");
  validateTimingSamples(baseline, "baseline samples");
  if (candidate.length !== baseline.length) {
    throw new Error("Candidate and baseline samples must have the same length.");
  }
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new Error("Bootstrap seed must be an unsigned 32-bit integer.");
  }
  if (!Number.isInteger(resamples) || resamples <= 0) {
    throw new Error("Bootstrap resamples must be a positive integer.");
  }

  const logRatios = candidate.map((value, index) => Math.log(value / baseline[index]));
  const geometricMeanDeltaPct = deltaFromLogRatios(logRatios);
  const random = createXorshift32(seed);
  const bootstrappedDeltas: number[] = [];

  for (let resampleIndex = 0; resampleIndex < resamples; resampleIndex += 1) {
    let totalLogRatio = 0;
    for (let sampleIndex = 0; sampleIndex < logRatios.length; sampleIndex += 1) {
      totalLogRatio += logRatios[Math.floor(random() * logRatios.length)];
    }
    bootstrappedDeltas.push((Math.exp(totalLogRatio / logRatios.length) - 1) * 100);
  }

  const sortedDeltas = bootstrappedDeltas.toSorted((left, right) => left - right);
  return {
    geometricMeanDeltaPct,
    ci95Pct: [nearestRank(sortedDeltas, 0.025), nearestRank(sortedDeltas, 0.975)],
  };
}

export function analyzeEagerGraph(entryPath: string): EagerGraphSummary {
  const fileContents = new Map<string, Buffer>();
  const externalPackages = new Set<string>();

  const visit = (filePath: string): void => {
    const resolvedPath = resolve(filePath);
    if (fileContents.has(resolvedPath)) {
      return;
    }

    let contents: Buffer;
    try {
      if (!statSync(resolvedPath).isFile()) {
        throw new Error("not a file");
      }
      contents = readFileSync(resolvedPath);
    } catch {
      throw new Error(`Unable to read eager graph path: ${resolvedPath}`);
    }

    fileContents.set(resolvedPath, contents);
    for (const specifier of staticImportSpecifiers(contents.toString("utf8"))) {
      if (specifier.startsWith("node:")) {
        continue;
      }
      if (specifier.startsWith(".") || specifier.startsWith("/")) {
        visit(specifier.startsWith("/") ? specifier : resolve(dirname(resolvedPath), specifier));
        continue;
      }
      externalPackages.add(packageNameForSpecifier(specifier));
    }
  };

  visit(entryPath);
  const files = [...fileContents.keys()].toSorted();
  const chunks = files.length;
  const contents = files.map((filePath) => getGraphFileContents(fileContents, filePath));
  const bytes = contents.reduce((total, fileContents) => total + fileContents.byteLength, 0);
  const source = Buffer.concat(contents);

  return {
    chunks,
    bytes,
    gzipBytes: gzipSync(source).byteLength,
    externalPackages: [...externalPackages].toSorted(),
    files,
  };
}

export function renderBenchmarkMarkdown(report: BenchmarkReport): string {
  const methodology = report.methodology;
  const environment = report.environment;
  const lines = [
    "# ACPX benchmark report",
    "",
    `Schema version: ${report.schemaVersion}`,
    "",
    "## Methodology",
    "",
    `- Samples per scenario: ${methodology.samplesPerScenario}`,
    `- Warmup samples: ${methodology.warmupSamples}`,
    `- Pairing: ${methodology.pairing}`,
    `- Bootstrap: ${methodology.bootstrapResamples} resamples with seed ${methodology.bootstrapSeed}`,
    "",
    "## Environment",
    "",
    `- Platform: ${environment.platform} ${environment.arch}`,
    `- Node: ${environment.nodeVersion}`,
    `- CPU: ${environment.cpuModel} (${environment.cpuCount} cores)`,
    `- Memory: ${environment.totalMemoryBytes} bytes`,
    "",
    "## Variants",
    "",
    "| Label | SHA | Worktree |",
    "| --- | --- | --- |",
    ...report.variants.map((variant) => `| ${variant.label} | ${variant.gitSha} | ${variant.worktree} |`),
    "",
    "## Eager graphs",
    "",
    "| Variant | Chunks | Bytes | Gzip bytes | External packages |",
    "| --- | ---: | ---: | ---: | --- |",
    ...report.eagerGraphs.map(
      (graph) =>
        `| ${graph.variantLabel} | ${graph.summary.chunks} | ${graph.summary.bytes} | ${graph.summary.gzipBytes} | ${graph.summary.externalPackages.join(", ")} |`,
    ),
  ];

  for (const scenario of report.scenarios) {
    lines.push("", `## ${scenario.name}`, "", `Command: \`${scenario.command}\``, "");
    lines.push("| Variant | Samples | Mean | Median | P95 | Stddev | Min | Max |", "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
    for (const variant of scenario.variants) {
      const summary = variant.summary;
      lines.push(
        `| ${variant.variantLabel} | ${summary.n} | ${formatMilliseconds(summary.meanMs)} | ${formatMilliseconds(summary.medianMs)} | ${formatMilliseconds(summary.p95Ms)} | ${formatMilliseconds(summary.stddevMs)} | ${formatMilliseconds(summary.minMs)} | ${formatMilliseconds(summary.maxMs)} |`,
      );
    }

    const comparison = scenario.comparison;
    lines.push(
      "",
      `Paired delta (${comparison.candidateLabel} vs ${comparison.baselineLabel}): ${formatPercent(comparison.pairedDelta.geometricMeanDeltaPct)} (95% CI ${formatPercent(comparison.pairedDelta.ci95Pct[0])} to ${formatPercent(comparison.pairedDelta.ci95Pct[1])}).`,
    );
    lines.push("", "### Trace summaries", "");
    if (scenario.traces.length === 0) {
      lines.push("No trace summaries captured.");
    } else {
      lines.push("| Variant | Trace | Events | Duration |", "| --- | --- | ---: | ---: |");
      for (const trace of scenario.traces) {
        lines.push(
          `| ${trace.variantLabel} | ${trace.tracePath} | ${trace.eventCount} | ${formatMilliseconds(trace.durationMs)} |`,
        );
      }
    }

    lines.push("", "### Internal metrics", "");
    if (!scenario.internalMetrics.supported) {
      lines.push(`Unsupported: ${scenario.internalMetrics.unsupportedReason ?? "not reported"}`);
      continue;
    }
    if (scenario.internalMetrics.metrics.length === 0) {
      lines.push("No internal metrics reported.");
      continue;
    }
    lines.push("| Metric | Count | Total | Max |", "| --- | ---: | ---: | ---: |");
    for (const metric of scenario.internalMetrics.metrics) {
      lines.push(
        `| ${metric.name} | ${metric.count} | ${formatMilliseconds(metric.totalMs)} | ${formatMilliseconds(metric.maxMs)} |`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

function validateTimingSamples(values: readonly number[], description: string): void {
  if (values.length === 0) {
    throw new Error(`${description} must contain at least one value.`);
  }
  if (values.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error(`${description} must contain only finite positive values.`);
  }
}

function nearestRank(sortedValues: readonly number[], percentile: number): number {
  return sortedValues[Math.max(0, Math.ceil(percentile * sortedValues.length) - 1)];
}

function deltaFromLogRatios(logRatios: readonly number[]): number {
  return (Math.exp(logRatios.reduce((sum, value) => sum + value, 0) / logRatios.length) - 1) * 100;
}

function createXorshift32(seed: number): () => number {
  let state = seed === 0 ? ZERO_SEED_STATE : seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

function staticImportSpecifiers(source: string): readonly string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(STATIC_IMPORT_PATTERN)) {
    const specifier = match[1];
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
  }
  return specifiers;
}

function packageNameForSpecifier(specifier: string): string {
  const pathSegments = specifier.split("/");
  return specifier.startsWith("@") ? pathSegments.slice(0, 2).join("/") : pathSegments[0];
}

function getGraphFileContents(fileContents: ReadonlyMap<string, Buffer>, filePath: string): Buffer {
  const contents = fileContents.get(filePath);
  if (contents === undefined) {
    throw new Error(`Missing eager graph contents for path: ${filePath}`);
  }
  return contents;
}

function formatMilliseconds(value: number): string {
  return `${value.toFixed(2)} ms`;
}

function formatPercent(value: number): string {
  return `${value.toFixed(2)}%`;
}
