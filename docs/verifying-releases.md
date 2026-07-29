# Verifying releases

The release automation can publish two independent artifacts, built and
attested by separate workflows:

- the **npm package** (`acpx`), published by `.github/workflows/release.yml`
- the **single-executable binaries** installed by `Formula/acpx.rb`, built by `.github/workflows/release-binaries.yml`

The npm package is published for every tag. Maintainers dispatch the binary
workflow separately after npm publication, because its macOS runners carry an
additional cost. Both artifact types carry build-provenance and SBOM
attestations. They describe different things, for reasons covered below.

## Verify the npm package

```bash
repo=openclaw/acpx
version=0.13.1
tag="v$version"
source_digest="$(gh api "repos/$repo/commits/$tag" --jq .sha)"
workdir="$(mktemp -d)"
npm install --prefix "$workdir" --ignore-scripts "acpx@$version"
npm audit signatures --prefix "$workdir"   # npm registry signatures and provenance
tarball="$(npm pack "acpx@$version" --silent)"
gh attestation verify "$tarball" \
  --repo "$repo" \
  --signer-workflow "$repo/.github/workflows/release.yml" \
  --source-digest "$source_digest" \
  --source-ref refs/heads/main
```

The package is published from a tarball that was attested before it left the
runner. The workflow, source digest, and source ref constraints above prove that
the bytes npm serves came from the expected release workflow at that tag's exact
commit on `main`.

## Verify a binary

```bash
repo=openclaw/acpx
version=0.13.1
tag="v$version"
source_digest="$(gh api "repos/$repo/commits/$tag" --jq .sha)"
gh attestation verify "acpx-$version-darwin-arm64.tar.gz" \
  --repo "$repo" \
  --signer-workflow "$repo/.github/workflows/release-binaries.yml" \
  --source-digest "$source_digest" \
  --source-ref refs/heads/main
```

This checks that the exact bytes you hold were produced by this repository's release workflow, at a tagged commit contained in `main`. It fails if the file was modified, rebuilt elsewhere, or attached by hand.

To read the SBOM attestation specifically, add `--predicate-type https://cyclonedx.org/bom`.

## What each release contains

| Asset                                     | What it is                                    |
| ----------------------------------------- | --------------------------------------------- |
| `acpx-<version>-<target>.tar.gz`          | The single-executable binary for one platform |
| `acpx-<version>-<target>.tar.gz.cdx.json` | CycloneDX SBOM describing that binary         |
| `SHA256SUMS`                              | Convenience index of every asset's digest     |

`SHA256SUMS` is not itself attested — it only restates digests the attestations already bind, so verify the tarball directly rather than trusting the manifest.

## Immutable releases are a release prerequisite

Maintainers must
[enable immutable releases](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/establish-provenance-and-integrity/prevent-release-changes)
before publishing executable assets. `release-binaries.yml` checks the
repository setting and fails before building when it is disabled. GitHub only
applies the setting to future releases.

The status endpoint requires repository **Administration: read**, a permission
that Actions cannot grant to `GITHUB_TOKEN`. Store a fine-grained token scoped
to this repository, with only that permission, as the
`RELEASE_SETTINGS_READER` Actions secret. The workflow fails closed when
the secret is absent or cannot read the setting.

An active ruleset applying to `main` must strictly require the exact
`Policy invariants` status context. In repository rules, enable the required
status check, set its expected source to **GitHub Actions**, and enable **Require
branches to be up to date before merging**. Source binding prevents another app
or actor from satisfying the rule with a same-named status. The binary release
gate queries the active rules that apply to `main` and stops before checkout
when any requirement is missing. Formula PRs created with `GITHUB_TOKEN` receive
an approval-required `pull_request` workflow run; a maintainer must approve that
run so `Policy invariants` can evaluate the candidate before merge.

Once enabled, published assets and their Git tag cannot be replaced. This is why
the workflow attaches every asset to a **draft** and publishes the draft last.
A botched binary release requires a new version rather than an in-place patch.

## The two SBOMs describe different things

This is the part worth reading before scanning either document.

**The npm package does not bundle dependency code.** It ships the compiled
`dist/` files, package metadata, and a production `npm-shrinkwrap.json`; npm
installs dependencies on the user's machine. The shrinkwrap makes the Homebrew
source fallback reproducible because the formula runs `npm ci`. Ordinary global
`npm install acpx` resolution still follows npm's consumer behavior and does not
honor a dependency package's shrinkwrap or root-only overrides.

The npm SBOM describes the production dependency closure. The workflow installs
the shipped shrinkwrap with `npm ci`, independently creates a production-only
pnpm deploy, and requires their package identities and registry integrity
digests to match before scanning the npm tree with a checksum-pinned
[Syft](https://github.com/anchore/syft) release binary. It also verifies that
built-in adapters are present and representative dev-only packages are absent
before attesting the document.

**The binary bundles everything.** It is one rolled-up chunk inside a V8 startup snapshot, injected into a copy of Node. Neither obvious scan target describes it:

| Scan target                | Components     | Why it is wrong                                  |
| -------------------------- | -------------- | ------------------------------------------------ |
| Source tree (Syft)         | hundreds       | Includes devDependencies that do not reach users |
| Production closure (Syft)  | hundreds       | Tree-shaking drops most of it                    |
| The finished binary (Syft) | zero observed  | No per-package boundaries survive bundling       |
| **Bundler module graph**   | build-specific | Exactly the packages whose code was inlined      |

So the binary's SBOM is produced by [`rollup-plugin-sbom`](https://github.com/janbiasi/rollup-plugin-sbom) during the build that makes the binary, reading the bundler's own module graph. See `scripts/sea/tsdown.sea.config.ts`.

That leaves one gap the bundler cannot see: the Node.js runtime. The executable is a copy of an official Node build, so Node — and with it V8, OpenSSL, zlib, and ICU — is the majority of the file and its largest attack surface. It is added as an explicit component with a `pkg:generic/node@<version>` purl, so scanners match Node advisories against the artifact.

Consequences worth knowing:

- **Build tooling is absent from the binary's SBOM, deliberately.** The bundler, type checker, and test runner never reach it. A devDependency advisory does not describe that artifact.
- **Native sidecars are represented by their JavaScript only.** Packages that ship a platform-specific binary have their JS inlined; the native executable is not inside the SEA.
- **No timestamps.** The binary SBOM disables them at generation time. The npm
  workflow removes Syft's timestamp and random serial number before attestation,
  so repeated builds do not differ solely because of wall-clock or UUID noise.
- **CycloneDX 1.6**, not the plugin's 1.7 default — that is what current attestation tooling and downstream scanners consume.
