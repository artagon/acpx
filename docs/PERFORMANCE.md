# Performance Benchmarking

Use `perf:benchmark` to compare already-built `acpx` worktrees with paired,
repeatable CLI measurements. The runner does not fetch, check out, install, or
build the target worktrees.

## Prepare benchmark inputs

Each input must be a Git worktree with:

- a resolvable Git `HEAD`; and
- a built `dist/cli.js` produced with that worktree's declared Node.js and
  package-manager versions.

For each target, install from its frozen lockfile and run its build before the
benchmark. The `perf:benchmark` package script builds the shared local
benchmark agent, but it does not rebuild the target CLIs.

The runner records each label, resolved worktree path, `HEAD` SHA, full Git
dirty state, and the validation-time SHA-256 of `dist/cli.js`. It rechecks that
expected digest immediately before every CLI spawn and after all invocations,
before constructing the final report, and fails if an observed digest differs.
These checks are not an immutable snapshot: a mutation in the narrow interval
between a recheck and process loading remains theoretically possible. It also
does not reject a dirty worktree or prove that the recorded binary was built
from `HEAD`. For reviewable results, use clean worktrees and read-only build
artifacts, rebuild after selecting each commit, and retain the build commands.

## Run a comparison

Invoke the benchmark from the worktree that contains the benchmark runner:

```text
pnpm run perf:benchmark -- \
  --baseline baseline=/path/to/acpx-baseline \
  --candidate candidate=/path/to/acpx-candidate \
  --output /path/to/benchmark-results
```

`--baseline` is required once. `--candidate` is required and repeatable. Each
value uses `label=worktree` syntax, and every label must be unique. Relative or
absolute worktree paths are accepted and resolved before execution.

The remaining options are:

```text
--scenario <name>             Repeat to select scenarios; omit for all defaults
--samples <positive-integer>  Override measured samples for every scenario
--warmups <nonnegative-int>   Override warmups for every scenario
--seed <uint32>               Override the deterministic bootstrap seed
--output <directory>          Select the report directory
```

The default seed is `2886672422`. Without `--output`, the runner creates a
temporary directory. It refuses to overwrite existing `results.json` or
`results.md` files and refuses concurrent use of the same output directory.

## Default scenarios

When no `--scenario` option is supplied, scenarios run in this order:

| Scenario         | Samples | Warmups | Measured behavior                                            |
| ---------------- | ------: | ------: | ------------------------------------------------------------ |
| `version`        |     100 |      15 | Process startup and `--version`                              |
| `help`           |      80 |      12 | Process startup and help rendering                           |
| `local-sessions` |      50 |       8 | Empty local session listing without an ACP child             |
| `agent-sessions` |      25 |       5 | Cold initialize, session-list RPC, and teardown              |
| `exec`           |      25 |       5 | Cold initialize, new session, prompt, response, and teardown |

`--scenario` is repeatable, for example `--scenario version --scenario help`.
Global sample and warmup overrides apply to every selected scenario.

The runner preflights every variant before warmups. Every CLI invocation gets
a new temporary HOME and working directory, including preflight, warmup,
measured, and diagnostic runs. This keeps session and configuration state from
one invocation out of the next.

The ACP scenarios use the same local benchmark agent for every variant. They
do not benchmark a live provider, credentials, or network service. Do not
replace that agent with a live or network-dependent adapter: provider and
network variance are outside this benchmark's contract.

## Interpret paired results

Each candidate is measured against the baseline in adjacent pairs. Pair order
alternates between baseline-first and candidate-first. A candidate is compared
only with the baseline observation at the same pair index; with multiple
candidates, each candidate receives its own baseline sample series.

Use the paired delta and confidence interval instead of comparing unpaired
summary means. Negative percentage deltas mean the candidate was faster.
Results describe the recorded host and run, not universal performance.

The runner supports POSIX platforms only because teardown depends on POSIX
process groups. It also requires permission to enumerate processes so it can
prove descendant ownership during cleanup; it fails closed when enumeration is
unavailable. It rejects Windows before execution.

## Outputs

Each successful run writes:

- `results.json`, the authoritative schema-versioned report with raw paired
  samples, input SHAs, dirty states, CLI digests, paths, environment,
  configuration, statistics, and diagnostics; and
- `results.md`, a concise human-readable rendering of the same report.

Diagnostic trace and internal-metrics files may also appear below the selected
output directory. Headline measured runs do not write those diagnostics. The
command prints the path to `results.json` when it finishes.

## `perf:benchmark` versus `perf:report`

`pnpm run perf:benchmark -- ...` launches built worktree CLIs, performs paired
measurements, and writes `results.json` plus `results.md`.

`pnpm run perf:report -- <metrics.ndjson>` only aggregates an existing
`ACPX_PERF_METRICS_FILE` NDJSON stream and prints a JSON summary. It does not
launch worktree variants, create paired samples, or produce benchmark result
files.
