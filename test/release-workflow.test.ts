import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * Invariants of the binary release pipeline.
 *
 * Two of these have already been violated in this repository — a release job
 * that held the signing identity while running dependency code, and a publish
 * step that only checked exit status — and both were invisible until a release
 * went out wrong. They are cheap to assert and expensive to rediscover.
 */

function readWorkflow(name: string): string {
  return readFileSync(path.join(process.cwd(), ".github", "workflows", name), "utf8");
}

/**
 * Drop whole-line YAML comments.
 *
 * Assertions like "this job must not mention id-token" otherwise match the
 * comment explaining why it must not — the failure mode that broke the
 * supply-chain policy gate, where a grep flagged its own rationale. Trailing
 * comments survive, because the action-pin assertions read the `# vX.Y.Z`
 * markers.
 */
function withoutComments(block: string): string {
  return block
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

/**
 * Split `jobs:` into its top-level children. A real YAML parser would be
 * better, but the repo has none and this file is machine-written with fixed
 * two-space indentation; a shape change fails the tests rather than passing
 * silently, which is the outcome that matters.
 */
function jobBlocks(workflow: string, keepComments = false): Map<string, string> {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line === "jobs:");
  assert.notEqual(start, -1, "workflow has no jobs: block");

  const blocks = new Map<string, string>();
  let current: string | undefined;
  let buffer: string[] = [];

  for (const line of lines.slice(start + 1)) {
    const header = /^ {2}([A-Za-z0-9_-]+):$/.exec(line);
    if (header) {
      if (current) {
        blocks.set(current, buffer.join("\n"));
      }
      current = header[1];
      buffer = [];
      continue;
    }
    if (current) {
      buffer.push(line);
    }
  }
  if (current) {
    blocks.set(current, buffer.join("\n"));
  }

  if (keepComments) {
    return blocks;
  }
  return new Map([...blocks].map(([name, block]) => [name, withoutComments(block)]));
}

test("release-binaries separates the signing identity from repository code", () => {
  const jobs = jobBlocks(readWorkflow("release-binaries.yml"));
  assert.deepEqual(
    [...jobs.keys()],
    ["gate", "build", "attest", "publish", "formula", "formula-pr"],
  );

  // `build` runs pnpm install, the bundler, and the freshly built binary. OIDC
  // there would let any of that code mint provenance for bytes the workflow
  // never produced.
  assert.doesNotMatch(jobs.get("build") ?? "", /id-token/);
  assert.match(jobs.get("build") ?? "", /permissions:\n\s+contents: read/);

  // `attest` holds the signing identity, so it must not check out or install.
  assert.match(jobs.get("attest") ?? "", /id-token: write/);
  assert.doesNotMatch(jobs.get("attest") ?? "", /contents: write/);
  assert.doesNotMatch(jobs.get("attest") ?? "", /actions\/checkout|pnpm install|run: pnpm/);

  // `publish` writes the release; it signs nothing.
  assert.doesNotMatch(jobs.get("publish") ?? "", /id-token/);
  assert.doesNotMatch(jobs.get("publish") ?? "", /actions\/checkout|pnpm install/);

  // `formula` executes the repository's generator script, so it must be
  // read-only: no OIDC, no write permission, no persisted credential, and it
  // must render from the immutable tag rather than a movable branch.
  assert.doesNotMatch(jobs.get("formula") ?? "", /id-token/);
  assert.match(jobs.get("formula") ?? "", /permissions:\n\s+contents: read/);
  assert.match(jobs.get("formula") ?? "", /persist-credentials: false/);
  assert.doesNotMatch(jobs.get("formula") ?? "", /ref: main/);
  assert.doesNotMatch(jobs.get("formula") ?? "", /pnpm install|npm install|npm ci\b/);

  // `formula-pr` holds the contents-write credential, so it must execute no
  // repository code: no script invocations, no dependency installs, no signing.
  assert.doesNotMatch(jobs.get("formula-pr") ?? "", /id-token/);
  assert.doesNotMatch(jobs.get("formula-pr") ?? "", /node scripts|pnpm|npm install|npm ci\b/);
});

test("the formula pins only verified bytes", () => {
  const formula = jobBlocks(readWorkflow("release-binaries.yml")).get("formula") ?? "";

  // The binary checksums come from the immutable release's manifest, not from
  // build artifacts that could be swapped between jobs.
  assert.match(formula, /gh release download .*SHA256SUMS/);

  // The npm checksum must not be trust-on-first-use: the tarball has to carry
  // this repository's provenance attestation (created by release.yml before
  // publish) before its sha256 is pinned into the formula.
  assert.match(formula, /gh attestation verify/);
});

test("every artifact gets both provenance and an SBOM attestation", () => {
  const attest = jobBlocks(readWorkflow("release-binaries.yml")).get("attest") ?? "";

  assert.match(attest, /actions\/attest-build-provenance@[0-9a-f]{40}/);
  assert.match(attest, /actions\/attest-sbom@[0-9a-f]{40}/);
  // A glob matching zero files would make both steps no-ops and ship unsigned
  // artifacts while the job stayed green.
  assert.match(attest, /Expected one tarball and one SBOM/);
});

test("assets are attached to a draft before the release is published", () => {
  const publish = jobBlocks(readWorkflow("release-binaries.yml")).get("publish") ?? "";

  // The repository has immutable releases enabled: assets and the Git tag
  // freeze at publication. Creating a published release and uploading into it
  // afterwards — the previous order — cannot work.
  const draftCreate = publish.indexOf("gh release create");
  const upload = publish.indexOf("gh release upload");
  const flipLive = publish.indexOf("--draft=false");

  assert.ok(draftCreate !== -1 && upload !== -1 && flipLive !== -1);
  assert.ok(draftCreate < upload, "the draft must exist before assets are uploaded");
  assert.ok(upload < flipLive, "assets must be attached before the draft is published");
  assert.match(publish.slice(draftCreate, upload), /--draft\b/);

  // Replacing an asset would swap bytes that were already attested.
  assert.doesNotMatch(publish, /--clobber/);
});

test("the packaged artifact is proven to be a SEA, not a bare Node copy", () => {
  const build = jobBlocks(readWorkflow("release-binaries.yml")).get("build") ?? "";

  // A failed injection leaves a Node copy that starts, exits 0, and answers
  // --version with Node's version. Checking exit status alone shipped one.
  assert.match(build, /the SEA blob was not injected/);
  assert.match(build, /reported.*!=.*expected|\[ "\$reported" != "\$expected" \]/s);
});

test("each release artifact runs the packaged persistent-session smoke tests", () => {
  const build = jobBlocks(readWorkflow("release-binaries.yml")).get("build") ?? "";
  const compileTests = build.indexOf("pnpm run build:test");
  const packagedTests = build.indexOf(
    'ACPX_TEST_PACKAGE_BIN="$workdir/acpx" node --test dist-test/test/packaged-bin.test.js',
  );

  assert.ok(compileTests >= 0, "the release build must compile packaged-bin tests");
  assert.ok(packagedTests > compileTests, "the built SEA must run the packaged-bin test suite");
});

test("the SBOM describes the artifact this job actually built", () => {
  const build = jobBlocks(readWorkflow("release-binaries.yml")).get("build") ?? "";

  // rollup-plugin-sbom reads the bundler's module graph, so it only knows what
  // the build told it. Both inputs are asserted after the fact: a mismatch
  // means the document describes a binary that was never produced.
  assert.match(build, /ACPX_SEA_TARGET: \$\{\{ matrix\.target \}\}/);
  assert.match(build, /ACPX_SEA_NODE_VERSION: \$\{\{ env\.NODE_VERSION \}\}/);
  assert.match(build, /SBOM target is/);
  assert.match(build, /SBOM node is/);
  assert.match(build, /SBOM has no Node runtime component/);

  // setup-node resolving a different Node would otherwise be signed as truth.
  assert.match(build, /the SBOM would misreport the runtime/);
});

test("the SEA build emits an SBOM and fails if it does not", () => {
  const buildScript = readFileSync(path.join(process.cwd(), "scripts", "sea", "build.mjs"), "utf8");
  const seaConfig = readFileSync(
    path.join(process.cwd(), "scripts", "sea", "tsdown.sea.config.ts"),
    "utf8",
  );

  // A plugin that silently stopped running would leave the release publishing
  // no SBOM, or attesting one from a previous build, while the job stayed green.
  assert.match(seaConfig, /rollup-plugin-sbom/);
  assert.match(buildScript, /rollup-plugin-sbom did not run/);
  assert.match(buildScript, /lists no components/);

  // 1.6, not the plugin's 1.7 default: an SBOM downstream tooling cannot parse
  // is worse than none.
  assert.match(seaConfig, /specVersion: "1\.6"/);
  // Reproducibility — a rebuild of the tag must diff clean against the publish.
  assert.match(seaConfig, /saveTimestamp: false/);
});
