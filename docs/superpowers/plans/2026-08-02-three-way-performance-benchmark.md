# Three-Way ACPX Performance Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reusable, statistically paired benchmark and use it to compare current OpenClaw `main`, OpenClaw PR #478, and Artagon performance PR #2.

**Architecture:** Functional TypeScript in `scripts/perf/` owns validation, ordering, statistics, eager-graph analysis, and rendering. Statistical transforms remain pure; filesystem reads and process spawning stay at explicit boundaries. A small functional ACP agent supplies one shared diagnostic fixture, while the runner spawns already-built checkouts and writes versioned JSON plus Markdown. Git fetching, worktree creation, dependency installation, and builds remain explicit controller operations outside the benchmark runner.

**Tech Stack:** Node.js >=22.13.0, strict TypeScript, Node test runner, `tsx`, ACP SDK, existing Oxlint/Oxfmt gates.

## Global Constraints

- Follow the existing repository's modular functional TypeScript style: small exported functions, explicit immutable data types, no benchmark classes, and side effects confined to executable boundaries.
- Do not use explicit `any`, unsafe assignment/calls/member access/returns, unchecked casts, or new dependencies.
- The runner SHALL NOT fetch, check out, install, build, merge, rebase, force-push, delete worktrees, or otherwise mutate Git state.
- OpenClaw PR #478 SHALL remain unchanged; benchmark code belongs only to `perf/consolidated-runtime` and Artagon PR #2.
- Every measured variant SHALL use the same benchmark agent built from the benchmark-owning performance worktree.
- Headline measured runs SHALL NOT write lifecycle traces or `ACPX_PERF_METRICS_FILE`; diagnostics use separate samples.
- Pair order SHALL alternate, raw samples SHALL be retained, and paired log-ratio confidence intervals SHALL use a deterministic 10,000-resample bootstrap.
- Reports SHALL record exact SHAs, paths, environment, scenario configuration, seed, and schema version.
- Missing trace events and unsupported internal metrics SHALL be reported as unavailable, never as zero.
- Tests SHALL be written and observed failing before implementation for every new behavior.
- Artagon Node and TypeScript plugin skills are unavailable in this runtime; workers SHALL instead follow this repository's Node/TypeScript rules, type-aware lint, and full-check contract.
- No shell source file is planned. If a worker finds shell unavoidable, it SHALL stop and report `NEEDS_CONTEXT`; any approved shell must use the Artagon shell skills and Google Shell Style Guide.
- Workers are not alone in the codebase. They SHALL preserve others' edits and SHALL NOT revert or overwrite files outside their assigned ownership.

---

### Task 1: Functional benchmark core

**Files:**

- Create: `scripts/perf/benchmark-core.ts`
- Create: `test/perf-benchmark-core.test.ts`
- Modify: `tsconfig.test.json`

**Interfaces:**

- Consumes: Node `fs`, `path`, `os`, and `zlib` only.
- Produces:

```ts
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

export function parseVariantSpec(value: string, optionName: string): VariantSpec;
export function createPairOrder<T>(baseline: T, candidate: T, sampleIndex: number): readonly [T, T];
export function summarizeSamples(values: readonly number[]): SampleSummary;
export function calculatePairedDelta(
  candidate: readonly number[],
  baseline: readonly number[],
  seed: number,
  resamples?: number,
): PairedDelta;
export function analyzeEagerGraph(entryPath: string): EagerGraphSummary;
export function renderBenchmarkMarkdown(report: BenchmarkReport): string;
```

Define `BenchmarkReport` and its nested report types in the same module. They
must model methodology, environment, variants, eager graphs, scenarios, raw
samples, candidate comparisons, trace summaries, and internal-metrics support
without open-ended `Record<string, unknown>` payloads.

- [ ] **Step 1: Include benchmark TypeScript in the test build**

Change `tsconfig.test.json` include to:

```json
["src/**/*.ts", "scripts/perf/**/*.ts", "test/**/*.ts", "examples/flows/pr-triage/review-text.js"]
```

- [ ] **Step 2: Write failing core tests**

Add focused Node tests that assert:

```ts
assert.deepEqual(parseVariantSpec("main=/repo/main", "--baseline"), {
  label: "main",
  worktree: "/repo/main",
});
assert.throws(() => parseVariantSpec("missing-separator", "--candidate"), /--candidate/u);
assert.deepEqual(createPairOrder("main", "pr", 0), ["main", "pr"]);
assert.deepEqual(createPairOrder("main", "pr", 1), ["pr", "main"]);
assert.deepEqual(summarizeSamples([1, 2, 3, 4, 100]), {
  n: 5,
  meanMs: 22,
  medianMs: 3,
  p95Ms: 100,
  stddevMs: 43.617656975128774,
  minMs: 1,
  maxMs: 100,
});
```

Use fixed baseline/candidate arrays to prove `calculatePairedDelta` returns the
same result twice with seed `0xac0f2026`, rejects unequal/empty/nonpositive
samples, and reports a negative delta for a faster candidate. Build an isolated
temporary eager graph containing local static imports, side-effect imports,
`node:` imports, and scoped/unscoped packages; assert exact sorted files,
packages, bytes, and gzip bytes. Construct a minimal typed report and assert
the Markdown includes schema version, exact SHAs, scenario headings, median,
p95, paired delta, and confidence interval.

- [ ] **Step 3: Run the test and verify RED**

Run:

```bash
rtk pnpm run build:test
```

Expected: FAIL because `scripts/perf/benchmark-core.ts` does not exist or its
exports are missing.

- [ ] **Step 4: Implement the minimal functional core**

Use immutable inputs, local `Map`/`Set` accumulation, a seeded xorshift32
generator, nearest-rank percentiles, sample standard deviation, and recursive
eager-import traversal. Reject non-finite/nonpositive timing samples and paths
that cannot be read. Round only when serializing/rendering; retain full
precision in calculations.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
rtk pnpm run build:test
rtk node --test dist-test/test/perf-benchmark-core.test.js
rtk pnpm run typecheck
rtk pnpm run lint
```

Expected: all commands pass with no warnings attributable to changed code.

- [ ] **Step 6: Commit Task 1**

```bash
rtk git add tsconfig.test.json scripts/perf/benchmark-core.ts test/perf-benchmark-core.test.ts
rtk git commit -m "feat: add reusable benchmark core"
```

### Task 2: Shared functional ACP benchmark agent

**Files:**

- Create: `scripts/perf/benchmark-agent.ts`
- Create: `test/perf-benchmark-agent.test.ts`

**Interfaces:**

- Consumes: `@agentclientprotocol/sdk`, Node streams, filesystem, crypto, and
  `performance.timeOrigin + performance.now()`.
- Produces:

```ts
export type BenchmarkTraceEventName =
  | "agent.process_start"
  | "agent.initialize.start"
  | "agent.initialize.end"
  | "agent.session_list.start"
  | "agent.session_list.end"
  | "agent.new_session.start"
  | "agent.new_session.end"
  | "agent.prompt.start"
  | "agent.prompt.end"
  | "agent.stdin_end"
  | "agent.sigterm"
  | "agent.exit";

export type BenchmarkTraceEvent = Readonly<{
  event: BenchmarkTraceEventName;
  pid: number;
  timestampMs: number;
}>;

export function appendBenchmarkTrace(
  traceFile: string | undefined,
  event: BenchmarkTraceEventName,
): void;

export function createBenchmarkAgent(
  connection: AgentSideConnection,
  traceFile: string | undefined,
): Agent;

export function parseBenchmarkAgentArgs(argv: readonly string[]): Readonly<{ traceFile?: string }>;

export async function runBenchmarkAgent(argv: readonly string[]): Promise<void>;
```

The executable calls `runBenchmarkAgent(process.argv.slice(2))` only when its
module URL matches the invoked entrypoint. It accepts only optional
`--trace-file <path>` and rejects unknown or missing arguments. With no trace
file, `appendBenchmarkTrace` returns without filesystem work.

- [ ] **Step 1: Write failing agent tests**

Assert that `appendBenchmarkTrace(undefined, ...)` creates no file; a real trace
file receives valid newline-delimited JSON with the requested event, current
PID, and finite timestamp; two appends preserve order; and argument parsing
rejects unknown/missing flags. Exercise the built agent through the existing
CLI with `sessions list` and `exec`, then assert the trace contains ordered
initialize plus workload events and a terminal stdin/signal/exit event.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
rtk pnpm run build:test
```

Expected: FAIL because `scripts/perf/benchmark-agent.ts` does not exist.

- [ ] **Step 3: Implement the minimal agent**

Construct an `Agent` object literal from closures rather than a class. Support
initialize, authenticate, new session, session list, prompt, cancel, and the
minimal permission/config methods required by the SDK type. The prompt handler
sends one deterministic assistant text update and returns `end_turn`. Use
synchronous append only when tracing is enabled so exit/signal events are not
lost.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
rtk pnpm run build:test
rtk node --test dist-test/test/perf-benchmark-agent.test.js
rtk pnpm run typecheck
rtk pnpm run lint
```

Expected: all commands pass.

- [ ] **Step 5: Commit Task 2**

```bash
rtk git add scripts/perf/benchmark-agent.ts test/perf-benchmark-agent.test.ts
rtk git commit -m "test: add shared benchmark ACP agent"
```

### Task 3: Benchmark runner, diagnostics, and package entrypoint

**Files:**

- Create: `scripts/perf/benchmark-runner.ts`
- Create: `test/perf-benchmark-runner.test.ts`
- Modify: `package.json`
- Modify: `test/package-scripts.test.ts`

**Interfaces:**

- Consumes: all Task 1 core exports and Task 2's compiled agent at
  `dist-test/scripts/perf/benchmark-agent.js`.
- Produces:

```ts
export type BenchmarkOptions = Readonly<{
  baseline: VariantSpec;
  candidates: readonly VariantSpec[];
  scenarios: readonly ScenarioName[];
  samplesOverride?: number;
  warmupsOverride?: number;
  seed: number;
  outputDirectory?: string;
}>;

export function parseBenchmarkArgs(argv: readonly string[]): BenchmarkOptions;
export async function runBenchmark(options: BenchmarkOptions): Promise<BenchmarkReport>;
export async function writeBenchmarkReport(
  report: BenchmarkReport,
  outputDirectory: string,
): Promise<Readonly<{ jsonPath: string; markdownPath: string }>>;
```

Scenario names and defaults are exact:

```ts
version: { samples: 100, warmups: 15 }
help: { samples: 80, warmups: 12 }
local-sessions: { samples: 50, warmups: 8 }
agent-sessions: { samples: 25, warmups: 5 }
exec: { samples: 25, warmups: 5 }
```

- [ ] **Step 1: Write failing runner and package tests**

Assert repeated candidates/scenarios parse correctly; labels are unique;
counts and seed are validated; worktrees must have resolvable Git HEAD and
`dist/cli.js`; failed preflight and measured commands include label/scenario
and stderr tail in the error; pair ordering alternates independently for every
candidate; and a fake executable CLI produces versioned JSON/Markdown with raw
samples. Assert package scripts contain exactly:

```json
"perf:benchmark": "pnpm run build:test && tsx scripts/perf/benchmark-runner.ts"
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
rtk pnpm run build:test
```

Expected: FAIL because runner exports and the package script do not exist.

- [ ] **Step 3: Implement argument and input validation**

Use `node:util` `parseArgs`, resolve absolute paths, read Git SHAs by spawning
`git` with `-C`, the resolved worktree path, `rev-parse`, and `HEAD` as separate
argv entries, and validate every variant before creating output state. Do not
invoke a shell.

- [ ] **Step 4: Implement measured and diagnostic runs**

For every pair, create fresh per-run HOME and cwd directories before starting
the timer. Measure with `performance.now()` immediately before `spawn` through
the child `close` event. Ignore measured stdout, drain stderr, and reject
nonzero exits. Use the shared agent command for ACP scenarios. Capture trace and
internal metrics only in separate diagnostic samples and derive stage summaries
only when required events are present.

- [ ] **Step 5: Implement reports and atomic writes**

Create the selected output directory without deleting existing data. Refuse to
overwrite existing `results.json` or `results.md`. Write same-directory
temporary files with exclusive creation, then rename. Print only the final JSON
path on stdout; diagnostics go to stderr.

- [ ] **Step 6: Verify GREEN**

Run:

```bash
rtk pnpm run build:test
rtk node --test dist-test/test/perf-benchmark-core.test.js dist-test/test/perf-benchmark-agent.test.js dist-test/test/perf-benchmark-runner.test.js dist-test/test/package-scripts.test.js
rtk pnpm run typecheck
rtk pnpm run lint
rtk pnpm run format:check
```

Expected: all commands pass.

- [ ] **Step 7: Commit Task 3**

```bash
rtk git add package.json scripts/perf/benchmark-runner.ts test/perf-benchmark-runner.test.ts test/package-scripts.test.ts
rtk git commit -m "feat: add reusable CLI benchmark"
```

### Task 4: Full validation and three-way execution

**Files:**

- No tracked source files unless validation exposes a defect.
- Output: a unique temporary benchmark directory containing `results.json` and
  `results.md`.

**Interfaces:**

- Consumes the Task 3 package entrypoint and three built worktrees.
- Produces exact three-way measurements and stage evidence.

- [ ] **Step 1: Run repository gates**

```bash
rtk pnpm run check
rtk pnpm run check:docs
rtk git diff --check
```

Expected: all pass.

- [ ] **Step 2: Fetch immutable comparison refs**

Fetch `upstream/main` and `refs/pull/478/head`, then record both fetched SHAs and
the current Artagon PR #2 head. Do not infer SHAs from old worktrees.

- [ ] **Step 3: Create detached isolated worktrees**

Use project-local ignored paths:

```text
.worktrees/openclaw-main-three-way
.worktrees/openclaw-pr-478-three-way
```

Refuse if either path already exists at a different SHA. Do not delete or prune
any current worktree.

- [ ] **Step 4: Install and build each variant**

Within each worktree, use its declared package-manager version:

```bash
rtk pnpm install --frozen-lockfile
rtk pnpm run build
```

In the performance worktree also run `rtk pnpm run build:test` for the shared
benchmark agent.

- [ ] **Step 5: Run the full three-way benchmark**

```bash
benchmark_output=""
benchmark_output="$(mktemp -d /private/tmp/acpx-three-way-benchmark.XXXXXX)"
readonly benchmark_output

rtk pnpm run perf:benchmark -- \
  --baseline openclaw-main=../openclaw-main-three-way \
  --candidate openclaw-pr-478=../openclaw-pr-478-three-way \
  --candidate artagon-performance=. \
  --seed 2886672422 \
  --output "${benchmark_output}"
```

Expected: `results.json` and `results.md` exist, every scenario contains the
configured raw sample count for all comparisons, SHAs match Git, and all child
runs exit zero.

- [ ] **Step 6: Interpret the cold path**

Compare PR #478 with OpenClaw main to isolate lifecycle changes. Compare Artagon
performance with PR #478 to isolate its additional lazy-loading and metrics
stack. Correlate cold ACP deltas with pre-agent, ACP-active, teardown, and
supported internal spans. Run one focused hypothesis experiment before naming
a root cause; otherwise label the result a correlation.

### Task 5: Review, publication, and PR update

**Files:**

- Modify only files required by accepted review findings.
- External output: Artagon PR #2 comment and normal branch push.

- [ ] **Step 1: Run repository autoreview**

Run `.agents/skills/autoreview/scripts/autoreview` in branch mode until no
accepted/actionable findings remain. Treat inability to obtain a final verdict
as an unresolved gate, not approval.

- [ ] **Step 2: Run `art-acpx.sh` performance and testing reviews**

Use
`/Users/gtrump001c@cable.comcast.com/Projects/Artagon/artagon-scripts/scripts/art-acpx.sh`,
one performance persona and one testing/API persona, against the full branch
range. Require fresh terminal final outputs;
session creation, ACKs, partial traces, or exit zero alone are not review proof.
Instruct every review lane that Artagon Node/TypeScript plugins are unavailable
and the authoritative fallback is this repository's functional TypeScript,
strict lint, and test contract.

- [ ] **Step 3: Resolve accepted findings through reviewed worker fixes**

For any accepted finding, dispatch one fresh fix worker with exact file
ownership, require focused tests, then run one scoped independent re-review.
Do not mix benchmark findings with unrelated existing branch changes.

- [ ] **Step 4: Push normally and publish evidence**

Push `perf/consolidated-runtime` without force. Comment on Artagon PR #2 with
the exact three SHAs, environment, methodology, result table, cold-path
evidence, and residual uncertainty. Do not put local filesystem paths or memory
citations in the PR comment.

- [ ] **Step 5: Final completion audit**

Verify the branch is clean, the remote head equals local HEAD, PR #2 is
mergeable, required checks are current, benchmark artifacts match the reported
SHAs, OpenClaw PR #478 is unchanged, and no unrelated worktree was deleted.
