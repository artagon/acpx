import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  analyzeEagerGraph,
  calculatePairedDelta,
  createPairOrder,
  parseVariantSpec,
  renderBenchmarkMarkdown,
  summarizeSamples,
  type BenchmarkReport,
} from "../scripts/perf/benchmark-core.js";

test("parses variants and alternates paired sample order", () => {
  assert.deepEqual(parseVariantSpec("main=/repo/main", "--baseline"), {
    label: "main",
    worktree: "/repo/main",
  });
  assert.throws(() => parseVariantSpec("missing-separator", "--candidate"), /--candidate/u);
  assert.deepEqual(createPairOrder("main", "pr", 0), ["main", "pr"]);
  assert.deepEqual(createPairOrder("main", "pr", 1), ["pr", "main"]);
});

test("summarizes timings using nearest-rank percentiles and sample deviation", () => {
  assert.deepEqual(summarizeSamples([1, 2, 3, 4, 100]), {
    n: 5,
    meanMs: 22,
    medianMs: 3,
    p95Ms: 100,
    stddevMs: 43.617656975128774,
    minMs: 1,
    maxMs: 100,
  });
});

test("calculates reproducible paired deltas and rejects invalid timing samples", () => {
  const baseline = [100, 120, 140, 160];
  const candidate = [90, 108, 126, 144];
  const first = calculatePairedDelta(candidate, baseline, 0xac0f2026);
  const second = calculatePairedDelta(candidate, baseline, 0xac0f2026);

  assert.deepEqual(first, second);
  assert.ok(Math.abs(first.meanDeltaPct + 10) < 1e-12);
  assert.ok(Math.abs(first.medianDeltaPct + 10) < 1e-12);
  assert.ok(first.geometricMeanDeltaPct < 0);
  assert.throws(() => calculatePairedDelta([], [], 0xac0f2026), /at least one/u);
  assert.throws(() => calculatePairedDelta([1], [1, 2], 0xac0f2026), /same length/u);
  assert.throws(() => calculatePairedDelta([0], [1], 0xac0f2026), /positive/u);
});

test("analyzes recursive eager imports without counting node built-ins as packages", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "acpx-eager-graph-"));
  const entryPath = join(fixtureRoot, "entry.js");
  const localPath = join(fixtureRoot, "local.js");
  const nestedPath = join(fixtureRoot, "nested.js");
  const sidePath = join(fixtureRoot, "side.js");

  try {
    writeFileSync(
      entryPath,
      'import "./local.js";\nimport "./side.js";\nimport "node:fs";\nimport "left-pad";\nimport "@scope/pkg";\n',
    );
    writeFileSync(localPath, 'import "./nested.js";\nexport const local = 1;\n');
    writeFileSync(nestedPath, "export const nested = 2;\n");
    writeFileSync(sidePath, "export {};\n");

    assert.deepEqual(analyzeEagerGraph(entryPath), {
      chunks: 4,
      bytes: 181,
      gzipBytes: 117,
      externalPackages: ["@scope/pkg", "left-pad"],
      files: [entryPath, localPath, nestedPath, sidePath],
    });
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});

test("analyzes multiline static import and export clauses", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "acpx-multiline-eager-graph-"));
  const entryPath = join(fixtureRoot, "entry.js");
  const localPath = join(fixtureRoot, "local.js");
  const nestedPath = join(fixtureRoot, "nested.js");

  try {
    writeFileSync(
      entryPath,
      'import {\n  local\n} from "./local.js";\nexport {\n  nested\n} from "./nested.js";\n',
    );
    writeFileSync(localPath, 'export {\n  value\n} from "@scope/pkg/subpath";\n');
    writeFileSync(nestedPath, "export const nested = 2;\n");

    const summary = analyzeEagerGraph(entryPath);
    assert.equal(summary.chunks, 3);
    assert.deepEqual(summary.externalPackages, ["@scope/pkg"]);
    assert.deepEqual(summary.files, [entryPath, localPath, nestedPath]);
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});

test("renders benchmark reports with comparison and trace evidence", () => {
  const report: BenchmarkReport = {
    schemaVersion: 1,
    methodology: {
      pairing: "alternating",
      bootstrapSeed: 0xac0f2026,
      bootstrapResamples: 1000,
    },
    environment: {
      hostname: "benchmark-host",
      osType: "Darwin",
      osRelease: "25.6.0",
      platform: "darwin",
      arch: "arm64",
      nodeExecutable: "/usr/local/bin/node",
      nodeVersion: "v22.13.0",
      cpuModel: "Apple M2 Pro",
      cpuCount: 10,
      totalMemoryBytes: 34_359_738_368,
      loadAverage: [0.25, 0.5, 0.75],
    },
    variants: [
      { label: "main", worktree: "/repo/main", gitSha: "abc123" },
      { label: "pr", worktree: "/repo/pr", gitSha: "def456" },
      { label: "artagon", worktree: "/repo/artagon", gitSha: "fed789" },
    ],
    eagerGraphs: [
      {
        variantLabel: "main",
        summary: {
          chunks: 1,
          bytes: 100,
          gzipBytes: 80,
          externalPackages: [],
          files: ["entry.js"],
        },
      },
      {
        variantLabel: "pr",
        summary: {
          chunks: 1,
          bytes: 120,
          gzipBytes: 90,
          externalPackages: [],
          files: ["entry.js"],
        },
      },
      {
        variantLabel: "artagon",
        summary: {
          chunks: 1,
          bytes: 110,
          gzipBytes: 85,
          externalPackages: [],
          files: ["entry.js"],
        },
      },
    ],
    scenarios: [
      {
        name: "version",
        command: "acpx --version",
        configuration: { samples: 2, warmups: 1 },
        comparisons: [
          {
            baselineLabel: "main",
            candidateLabel: "pr",
            pairedSamples: [
              { sampleIndex: 0, order: "baseline-first", baselineMs: 100, candidateMs: 90 },
              { sampleIndex: 1, order: "candidate-first", baselineMs: 110, candidateMs: 100 },
            ],
            baselineSummary: {
              n: 2,
              meanMs: 105,
              medianMs: 105,
              p95Ms: 110,
              stddevMs: 7.071,
              minMs: 100,
              maxMs: 110,
            },
            candidateSummary: {
              n: 2,
              meanMs: 95,
              medianMs: 95,
              p95Ms: 100,
              stddevMs: 7.071,
              minMs: 90,
              maxMs: 100,
            },
            pairedDelta: {
              meanDeltaPct: -9.524,
              medianDeltaPct: -9.524,
              geometricMeanDeltaPct: -9.535,
              ci95Pct: [-10, -9.091],
            },
          },
          {
            baselineLabel: "main",
            candidateLabel: "artagon",
            pairedSamples: [
              { sampleIndex: 0, order: "baseline-first", baselineMs: 200, candidateMs: 160 },
              { sampleIndex: 1, order: "candidate-first", baselineMs: 220, candidateMs: 180 },
            ],
            baselineSummary: {
              n: 2,
              meanMs: 210,
              medianMs: 210,
              p95Ms: 220,
              stddevMs: 14.142,
              minMs: 200,
              maxMs: 220,
            },
            candidateSummary: {
              n: 2,
              meanMs: 170,
              medianMs: 170,
              p95Ms: 180,
              stddevMs: 14.142,
              minMs: 160,
              maxMs: 180,
            },
            pairedDelta: {
              meanDeltaPct: -19.048,
              medianDeltaPct: -19.048,
              geometricMeanDeltaPct: -19.096,
              ci95Pct: [-20, -18.182],
            },
          },
        ],
        diagnostics: [
          {
            variantLabel: "main",
            trace: {
              capture: {
                state: "unavailable",
                tracePath: null,
                unavailableReason: "scenario has no ACP child",
              },
              preAgent: { state: "unavailable", unavailableReason: "no trace capture" },
              acpActive: { state: "unavailable", unavailableReason: "no trace capture" },
              teardown: { state: "unavailable", unavailableReason: "no trace capture" },
            },
            internalMetrics: {
              state: "unavailable",
              metricsPath: null,
              unavailableReason: "scenario has no ACP child",
            },
          },
          {
            variantLabel: "pr",
            trace: {
              capture: { state: "available", tracePath: "traces/pr-version.json", eventCount: 4 },
              preAgent: { state: "available", durationMs: 0 },
              acpActive: { state: "available", durationMs: 45 },
              teardown: { state: "available", durationMs: 10 },
            },
            internalMetrics: {
              state: "available",
              metricsPath: "metrics/pr-version.json",
              metrics: [{ name: "session.load", count: 2, totalMs: 190, maxMs: 100 }],
            },
          },
          {
            variantLabel: "artagon",
            trace: {
              capture: {
                state: "unavailable",
                tracePath: "/tmp/artagon-trace.json",
                unavailableReason: "trace was truncated",
              },
              preAgent: { state: "unavailable", unavailableReason: "missing process start" },
              acpActive: { state: "unavailable", unavailableReason: "missing workload end" },
              teardown: { state: "unavailable", unavailableReason: "missing workload end" },
            },
            internalMetrics: {
              state: "unavailable",
              metricsPath: "/tmp/artagon-metrics.json",
              unavailableReason: "build does not support internal metrics",
            },
          },
        ],
      },
    ],
  };

  const markdown = renderBenchmarkMarkdown(report);

  assert.match(markdown, /Schema version: 1/u);
  assert.match(markdown, /abc123/u);
  assert.match(markdown, /def456/u);
  assert.match(markdown, /fed789/u);
  assert.match(markdown, /## version/u);
  assert.match(markdown, /Samples: 2/u);
  assert.match(markdown, /Warmups: 1/u);
  assert.match(markdown, /Median/u);
  assert.match(markdown, /P95/u);
  assert.match(markdown, /Mean delta/u);
  assert.match(markdown, /Median delta/u);
  assert.match(markdown, /Paired geometric delta/u);
  assert.match(markdown, /95% CI/u);
  assert.match(markdown, /105\.00 ms/u);
  assert.match(markdown, /210\.00 ms/u);
  assert.match(markdown, /Pre-agent/u);
  assert.match(markdown, /0\.00 ms/u);
  assert.match(markdown, /Unavailable: missing process start/u);
  assert.match(markdown, /Not attempted/u);
  assert.match(markdown, /\/tmp\/artagon-trace\.json/u);
  assert.match(markdown, /\/tmp\/artagon-metrics\.json/u);
  assert.match(markdown, /benchmark-host/u);
  assert.match(markdown, /Darwin 25\.6\.0/u);
  assert.match(markdown, /\/usr\/local\/bin\/node/u);
  assert.match(markdown, /0\.25, 0\.50, 0\.75/u);
});
