# Packaging

acpx ships two ways. They are independent artifacts with different tradeoffs;
pick per audience rather than treating one as a replacement for the other.

|                         | npm (`npm i -g acpx`)  | single executable (Homebrew)               |
| ----------------------- | ---------------------- | ------------------------------------------ |
| `--version` startup     | 120.5 ± 5.8 ms         | **67.8 ± 5.7 ms**                          |
| Requires a system Node  | yes (>= 22.13)         | for adapter subprocesses, not `acpx`       |
| Artifact size           | ~640 KB `dist/`        | ~128 MB binary (~40 MB compressed)         |
| First run after install | normal                 | one-off code-signature validation on macOS |
| Updates                 | `npm i -g acpx@latest` | new release + `brew upgrade`               |
| Platforms per release   | one                    | one per os/arch                            |

Startup figures are hyperfine, 25 runs, macOS arm64, measured from the current
branch with Node 26.5.0 for npm and the official Node 24.11.0 SEA runtime. The
executable ran 1.78 ± 0.17 times faster because a V8 startup snapshot executes
the module graph at _build_ time; the npm build pays module init on every
invocation.

That measurement covers acpx process startup only. A new Codex or Claude
process launches directly from the npm install, while the standalone executable
invokes package-backed adapters through `npx` each time a new adapter process is
needed. The npm cache avoids repeat downloads, and persistent queue-owner
sessions reuse the live adapter across prompts. `flow` commands are another
deliberate exception: the executable extracts an embedded runtime and delegates
to the formula's Node dependency because a V8 startup snapshot cannot
dynamically import user flow modules.

## Building the single executable

```bash
pnpm run sea
```

Produces `dist-sea/acpx`.

### Requirements

The build needs a Node with single-executable support **compiled in**.
Homebrew's node is not built that way and will fail with
`Single executable application is disabled.` Point `ACPX_SEA_NODE` at an
official nodejs.org build:

```bash
ACPX_SEA_NODE="$HOME/.local/share/nvm/v24.11.0/bin/node" pnpm run sea
```

The script fails fast with this instruction if the chosen Node cannot build a
SEA, rather than surfacing an opaque spawn error.

### How it works, and the constraints that shaped it

`scripts/sea/build.mjs` runs four steps: bundle → shim → snapshot → inject.

- **One CommonJS chunk, everything inlined** (`scripts/sea/tsdown.sea.config.ts`).
  A snapshot resolves nothing from disk at runtime, so code splitting is off and
  no dependency may stay external. This is also why the executable cannot use
  the lazy-import graph the npm build relies on — and why it does not need to.
- **CommonJS, not ESM.** Node rejects `mainFormat: "module"` together with
  `useSnapshot`, and the snapshot is the entire point of this build.
- **A CJS wrapper shim** is prepended to the bundle. `useSnapshot` executes the
  main script through Node's `minimalRunCjs`, which does not define
  `exports`/`module`; without the shim the build fails with
  `exports is not defined`. IIFE is not a workaround — it hoists
  `require("node:*")` to globals and fails with `node_v8 is not defined`.
- **argv keeps node's shape.** A SEA's `process.argv[1]` is the path the user
  typed, not the first user argument. Re-injecting it makes `cli-core` read it
  as the agent name and shadow every top-level verb, which silently breaks
  `--version` and every subcommand. `src/sea/entry.ts` passes `process.argv`
  through unchanged.
- **postject + codesign** inject the blob into a copy of the host Node binary.
  On macOS the signature must be removed before injection and re-applied after.
- **Flow runtime assets** keep user-authored JavaScript and TypeScript flows
  working. The SEA embeds a fully bundled CLI entry and `acpx/flows` runtime,
  extracts them into a private temporary directory for `flow` commands, and
  executes them with Node >= 22.13 from `PATH`; all other commands remain on the
  snapshot fast path.

## Installing via Homebrew

The repository is its own tap — `Formula/acpx.rb` lives at the root, so no
separate tap repo is needed:

```bash
brew tap openclaw/acpx https://github.com/openclaw/acpx
brew install openclaw/acpx/acpx
```

The checked-in v0.12.1 bootstrap formula predates the publishable shrinkwrap and
retains its legacy dynamic npm install. Newly generated formulas replace that
source with platform-specific executable assets while retaining a fail-closed
npm fallback for unsupported platforms. That fallback requires the shrinkwrap
inside the attested npm archive and runs `npm ci --omit=dev`; release validation
also proves that npm and pnpm select the same production package identities and
integrity hashes. A normal registry install such as `npm i -g acpx` does not
enforce a dependency package's shrinkwrap and retains npm's standard
dependency-resolution semantics.

The formula always depends on Node because Codex and Claude adapters execute as
separate JavaScript processes. The binary still avoids Node module
initialization for the `acpx` process itself, which is the source of the
measured startup improvement.

## Publishing a Homebrew release

The `Release binaries` workflow owns the release path:

1. A maintainer enables GitHub release immutability for the repository and
   configures the `RELEASE_SETTINGS_READER` Actions secret. Use a
   fine-grained token scoped to this repository with only
   **Administration: read**; the workflow's `GITHUB_TOKEN` cannot query that
   setting. An active ruleset applying to `main` must also require the exact
   `Policy invariants` status context, bind its expected source to **GitHub
   Actions**, and enable **Require branches to be up to date before merging**.
   The binary gate reads the active rules that apply to `main` and fails before
   checkout if any protection is absent.
2. A `vX.Y.Z` tag push runs the unprivileged `Release request` workflow.
   Successful requests trigger `release.yml` from the default branch. Before
   checkout, its gate requires the request SHA, live tag SHA, default-branch
   event SHA, and workflow SHA to match. Build/package validation runs without
   OIDC; a separate same-run artifact job attests and publishes the npm tarball.
3. After npm publication, a maintainer triggers the trusted default-branch
   binary workflow:

   ```bash
   gh api --method POST repos/openclaw/acpx/dispatches \
     -f event_type=release-binaries \
     -F 'client_payload[tag]=vX.Y.Z'
   ```

   Its pre-checkout gate applies the same live-tag, workflow-SHA, and
   default-branch binding.

4. Four native jobs build and test the platform executables without write or
   OIDC permissions.
5. Separate jobs attest each tarball and its CycloneDX SBOM. Before any release
   draft is created, the publisher verifies the npm tarball against the exact
   `release.yml` signer, source digest, and `refs/heads/main` source ref. It
   refuses every pre-existing release and publishes only a fresh draft whose
   nine assets and metadata match the expected set.
6. A read-only job verifies that same npm provenance, rejects a formula version
   that does not advance live `main`, and renders from published checksums.
7. A credential-only job rebases the generated formula onto live `main` and
   opens a PR without executing repository code. GitHub creates its
   `pull_request` workflows in an approval-required state because the PR was
   created with `GITHUB_TOKEN`; a maintainer must approve the run. The
   `Policy invariants` job independently rejects stale or downgraded formula
   versions, and the strict required-status rule prevents merge until that
   exact candidate has passed against current `main`.

The separation is deliberate. Build dependencies and repository code never run
in the jobs that hold release-write or binary-attestation credentials. Formula
generation likewise runs without a write token; the writer only commits the
rendered artifact. GitHub does not expose an atomic compare-and-publish release
operation, so the workflows recheck the live tag immediately before publish;
repository policy must also prevent release-tag updates and deletion.
