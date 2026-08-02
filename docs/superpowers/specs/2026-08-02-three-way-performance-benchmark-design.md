# Three-Way ACPX Performance Benchmark Design

## Goal

Create a reusable benchmark that compares built ACPX checkouts without changing
the revisions being measured. Use it to compare current OpenClaw `main`,
OpenClaw PR #478, and Artagon performance PR #2, then retain the tool on the
Artagon performance branch.

The benchmark must answer two separate questions:

1. How do the three revisions compare for end-to-end CLI latency and eager-load
   size?
2. Which lifecycle stage accounts for any cold ACP regression?

## Ownership and isolation

The reusable benchmark belongs to `perf/consolidated-runtime`, the branch behind
Artagon PR #2. OpenClaw PR #478 remains unchanged so it can be measured as the
submitted lifecycle fix rather than as a benchmark-modified revision.

The comparison uses three independent worktrees:

- a detached worktree pinned to the fetched OpenClaw `main` SHA;
- a detached worktree pinned to OpenClaw PR #478's fetched head SHA; and
- the existing `perf/consolidated-runtime` worktree pinned to Artagon PR #2's
  head SHA.

The runner accepts worktree paths and never fetches, checks out, installs,
builds, or mutates Git state. Preparation remains an explicit outer workflow so
the report can record and verify the exact already-built inputs.

## Components

### Benchmark core

A functional TypeScript module under `scripts/perf/` owns:

- variant and scenario validation;
- deterministic alternating order generation;
- descriptive statistics;
- paired log-ratio deltas and seeded bootstrap confidence intervals;
- eager-import graph accounting; and
- JSON and Markdown report rendering.

Keeping these functions separate lets focused tests prove the statistical and
reporting contract without spawning hundreds of processes. Statistical,
ordering, validation, and rendering functions are pure. Eager-graph analysis
is a read-only filesystem boundary and performs no writes.

### Benchmark runner

The executable TypeScript entrypoint under `scripts/perf/` accepts:

```text
--baseline <label>=<worktree>
--candidate <label>=<worktree>       # repeatable
--scenario <name>                    # repeatable; all defaults when omitted
--samples <positive-integer>         # optional global override
--warmups <nonnegative-integer>      # optional global override
--seed <unsigned-integer>            # deterministic default when omitted
--output <directory>                 # temporary directory when omitted
```

Every worktree must contain `dist/cli.js` and its Git HEAD must resolve to a
commit. Labels must be unique. The runner rejects missing builds, duplicate
labels, invalid counts, failed preflight commands, and nonzero measured runs.

The package entrypoint is `pnpm run perf:benchmark -- <arguments>`. It builds
the shared benchmark agent once, then invokes the runner. Candidate worktrees
remain caller-prepared and immutable.

### Shared benchmark ACP agent

All variants use one agent built from the benchmark-owning performance
worktree. This removes agent implementation drift from the comparison. The
agent implements the minimal initialize, session-list, new-session, and prompt
behavior needed by the default workloads.

For diagnostic runs it appends timestamped lifecycle events to a per-run trace:

- agent process start;
- initialize request entry and completion;
- session-list or prompt request entry and completion;
- stdin end or termination signal; and
- process exit.

The runner records its own spawn and child-close timestamps from the same
monotonic epoch. It derives pre-agent, ACP-active, and post-agent teardown spans
where the required events exist. Missing or truncated trace events are reported
as unavailable rather than converted into misleading zeroes.

The measured latency runs do not write trace or internal-metrics files. Stage
traces and `ACPX_PERF_METRICS_FILE` capture use separate diagnostic samples so
instrumentation I/O cannot contaminate the headline timings. Builds that do not
support internal metrics are identified explicitly.

## Default scenarios

| Scenario         | Default samples | Default warmups | Measured behavior                                            |
| ---------------- | --------------: | --------------: | ------------------------------------------------------------ |
| `version`        |             100 |              15 | Process startup and `--version`                              |
| `help`           |              80 |              12 | Process startup and help rendering                           |
| `local-sessions` |              50 |               8 | Empty local session listing without an ACP child             |
| `agent-sessions` |              25 |               5 | Cold initialize, session-list RPC, and teardown              |
| `exec`           |              25 |               5 | Cold initialize, new session, prompt, response, and teardown |

Each scenario is preflighted once for every variant before warmups begin.
Measured runs discard stdout, drain stderr, use an isolated HOME and working
directory, and start with empty ACPX session state.

## Pairing and statistics

The baseline and every candidate run in adjacent pairs. Pair order alternates
on each sample to reduce first-run and short-term load bias. A candidate is
compared only with the baseline observation from the same pair index.

Each report includes raw samples plus count, mean, median, p95, standard
deviation, minimum, and maximum. Relative results include median and mean
deltas and the geometric mean of paired ratios. A deterministic 10,000-sample
bootstrap over paired log ratios produces the 95% confidence interval. Negative
deltas mean the candidate is faster.

The report describes measurements, not universal performance. It records host,
OS, architecture, Node executable and version, logical CPU count, memory, load,
worktree paths, labels, SHAs, order policy, seed, and scenario configuration.

## Output

Each invocation writes:

- `results.json`, the authoritative machine-readable report with raw samples;
- `results.md`, a concise comparison table and methodology summary;
- optional per-variant diagnostic trace and internal-metrics files; and
- no files outside the selected output directory.

The JSON format carries a schema version so later benchmark evolution can be
detected. Markdown is rendered from the same in-memory report, preventing
hand-copied result drift.

## Testing

Tests are written before implementation and cover:

- repeated baseline/candidate parsing and validation;
- missing builds, duplicate labels, and invalid numeric arguments;
- deterministic alternating order for two and three variants;
- percentile and summary calculations on fixed samples;
- deterministic paired bootstrap output for a fixed seed;
- missing trace events and unsupported internal metrics;
- eager-graph traversal with local, external, and side-effect imports;
- JSON schema-version content and Markdown table rendering; and
- a minimal subprocess smoke test using fake CLI and agent fixtures.

The implementation then runs the focused benchmark tests, `pnpm run check`,
`pnpm run check:docs`, and the repository autoreview requirement before push.

## Execution and interpretation

After the tool is verified:

1. Fetch OpenClaw `main` and PR #478 and record their exact SHAs.
2. Create or refresh separate detached worktrees without deleting unrelated
   worktrees.
3. Install with the repository-pinned pnpm version and build each checkout.
4. Run one three-way benchmark from the Artagon performance worktree.
5. Use the PR #478 versus OpenClaw `main` result to isolate lifecycle changes.
6. Use Artagon PR #2 versus PR #478 to isolate the additional startup and
   instrumentation stack.
7. Correlate end-to-end cold ACP deltas with external stage traces and supported
   internal metrics. Treat correlation as a lead unless a focused experiment
   changes only the suspected stage.
8. Publish the exact SHAs, method, results, and residual uncertainty to the
   relevant Artagon PR without claiming a blanket speedup when scenarios move
   in opposite directions.

## Non-goals

- The benchmark does not mutate, merge, rebase, or force-push any measured
  branch.
- It does not benchmark live model providers or network latency.
- It does not convert noisy local timings into a CI pass/fail gate.
- It does not replace the deterministic eager-import graph check.
- It does not place benchmark tooling into OpenClaw PR #478.
