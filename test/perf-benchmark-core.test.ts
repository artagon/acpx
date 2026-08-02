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

test("renders benchmark reports with comparison and trace evidence", () => {
  const report: BenchmarkReport = {
    schemaVersion: 1,
    methodology: {
      samplesPerScenario: 2,
      warmupSamples: 1,
      pairing: "alternating",
      bootstrapSeed: 0xac0f2026,
      bootstrapResamples: 1000,
    },
    environment: {
      platform: "darwin",
      arch: "arm64",
      nodeVersion: "v22.13.0",
      cpuModel: "Apple M2 Pro",
      cpuCount: 10,
      totalMemoryBytes: 34_359_738_368,
    },
    variants: [
      { label: "main", worktree: "/repo/main", gitSha: "abc123" },
      { label: "pr", worktree: "/repo/pr", gitSha: "def456" },
    ],
    eagerGraphs: [
      {
        variantLabel: "main",
        summary: { chunks: 1, bytes: 100, gzipBytes: 80, externalPackages: [], files: ["entry.js"] },
      },
      {
        variantLabel: "pr",
        summary: { chunks: 1, bytes: 120, gzipBytes: 90, externalPackages: [], files: ["entry.js"] },
      },
    ],
    scenarios: [
      {
        name: "version",
        command: "acpx --version",
        variants: [
          {
            variantLabel: "main",
            samplesMs: [100, 110],
            summary: { n: 2, meanMs: 105, medianMs: 105, p95Ms: 110, stddevMs: 7.071, minMs: 100, maxMs: 110 },
          },
          {
            variantLabel: "pr",
            samplesMs: [90, 100],
            summary: { n: 2, meanMs: 95, medianMs: 95, p95Ms: 100, stddevMs: 7.071, minMs: 90, maxMs: 100 },
          },
        ],
        comparison: {
          baselineLabel: "main",
          candidateLabel: "pr",
          pairedDelta: { geometricMeanDeltaPct: -9.307, ci95Pct: [-10, -8] },
        },
        traces: [
          { variantLabel: "pr", tracePath: "traces/pr-version.json", eventCount: 4, durationMs: 100 },
        ],
        internalMetrics: {
          supported: true,
          unsupportedReason: null,
          metrics: [{ name: "session.load", count: 2, totalMs: 190, maxMs: 100 }],
        },
      },
    ],
  };

  const markdown = renderBenchmarkMarkdown(report);

  assert.match(markdown, /Schema version: 1/u);
  assert.match(markdown, /abc123/u);
  assert.match(markdown, /def456/u);
  assert.match(markdown, /## version/u);
  assert.match(markdown, /Median/u);
  assert.match(markdown, /P95/u);
  assert.match(markdown, /Paired delta/u);
  assert.match(markdown, /95% CI/u);
});
