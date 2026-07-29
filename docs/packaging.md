# Packaging

acpx ships two ways. They are independent artifacts with different tradeoffs;
pick per audience rather than treating one as a replacement for the other.

|                         | npm (`npm i -g acpx`)  | single executable (Homebrew)               |
| ----------------------- | ---------------------- | ------------------------------------------ |
| `--version` startup     | 77.1 ± 5.7 ms          | **50.2 ± 3.7 ms**                          |
| Requires a system Node  | yes (>= 22.13)         | for adapter subprocesses, not `acpx`       |
| Artifact size           | ~640 KB `dist/`        | ~122 MB binary (~39 MB compressed)         |
| First run after install | normal                 | one-off code-signature validation on macOS |
| Updates                 | `npm i -g acpx@latest` | new release + `brew upgrade`               |
| Platforms per release   | one                    | one per os/arch                            |

Startup figures are hyperfine, 25 runs, macOS arm64. The executable is faster
because a V8 startup snapshot executes the module graph at _build_ time; the npm
build pays module init on every invocation.

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

## Installing via Homebrew

The repository is its own tap — `Formula/acpx.rb` lives at the root, so no
separate tap repo is needed:

```bash
brew tap openclaw/acpx https://github.com/openclaw/acpx
brew install openclaw/acpx/acpx
```

The checked-in bootstrap formula installs the latest published npm package.
After the first binary release completes, the formula update workflow replaces
that source with platform-specific executable assets while retaining an npm
fallback for unsupported platforms. The formula always depends on Node because
Codex and Claude adapters execute as separate JavaScript processes. The binary
still avoids Node module initialization for the `acpx` process itself, which is
the source of the measured startup improvement.

## Publishing a Homebrew release

The `Release binaries` workflow owns the release path:

1. A maintainer enables GitHub release immutability for the repository and
   configures the `RELEASE_SETTINGS_READER` Actions secret. Use a
   fine-grained token scoped to this repository with only
   **Administration: read**; the workflow's `GITHUB_TOKEN` cannot query that
   setting.
2. A normal tag release publishes and attests the npm tarball.
3. A maintainer dispatches `release-binaries.yml` with that tag and selects the
   same tag as the workflow ref. The gate rejects a branch ref so GitHub's
   provenance identity, the validated source, and every matrix checkout name
   one commit.
4. Four native jobs build and test the platform executables without write or
   OIDC permissions.
5. Separate jobs attest each tarball and its CycloneDX SBOM, then publish all
   assets through a draft release.
6. A read-only job verifies the npm tarball's provenance and renders the
   formula from the published checksums.
7. A credential-only job opens a formula PR without executing repository code.

The separation is deliberate. Build dependencies and repository code never run
in the jobs that hold release-write or binary-attestation credentials. Formula
generation likewise runs without a write token; the writer only commits the
rendered artifact.
