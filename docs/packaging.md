# Packaging

acpx ships two ways. They are independent artifacts with different tradeoffs;
pick per audience rather than treating one as a replacement for the other.

|                         | npm (`npm i -g acpx`)  | single executable (Homebrew)               |
| ----------------------- | ---------------------- | ------------------------------------------ |
| `--version` startup     | 77.1 ± 5.7 ms          | **50.2 ± 3.7 ms**                          |
| Requires a system Node  | yes (>= 22.13)         | no                                         |
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
brew tap artagon/acpx https://github.com/artagon/acpx
brew install artagon/acpx/acpx
```

## Publishing a Homebrew release

1. `pnpm run sea` on each target os/arch.
2. `tar -czf acpx-<version>-<os>-<arch>.tar.gz -C <dir> acpx`
3. Attach the tarballs to the GitHub release for that version.
4. Update `version` and each `sha256` in `Formula/acpx.rb` from
   `shasum -a 256` of the uploaded assets, and commit.

`Formula/acpx.rb` carries `REPLACE_ON_RELEASE` placeholders until the first
release exists; `brew install` fails loudly on a checksum mismatch, so an
un-updated formula cannot silently install the wrong artifact.
