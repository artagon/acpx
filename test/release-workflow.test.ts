import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

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

type PackedProject = {
  packageDir: string;
  files: readonly string[];
  npmCache: string;
};

function packProject(t: TestContext): PackedProject {
  const dir = mkdtempSync(path.join(os.tmpdir(), "acpx-pack-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const npmCache = path.join(dir, "npm-cache");
  const result = spawnSync(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", dir],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        npm_config_cache: npmCache,
        npm_config_update_notifier: "false",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);

  const reports = JSON.parse(result.stdout) as {
    filename: string;
    files: { path: string }[];
  }[];
  assert.equal(reports.length, 1, "npm pack must emit exactly one archive report");

  const extractDir = path.join(dir, "extract");
  mkdirSync(extractDir);
  const extract = spawnSync(
    "tar",
    ["-xzf", path.join(dir, reports[0].filename), "-C", extractDir],
    { encoding: "utf8" },
  );
  assert.equal(extract.status, 0, extract.stderr);

  return {
    packageDir: path.join(extractDir, "package"),
    files: reports[0].files.map((file) => file.path),
    npmCache,
  };
}

type PackageResolution = {
  integrity: string;
  resolved: string;
};

type NpmShrinkwrap = {
  packages?: Record<
    string,
    {
      dev?: boolean;
      integrity?: string;
      name?: string;
      resolved?: string;
      version?: string;
    }
  >;
};

function packageNameFromLockPath(lockPath: string): string {
  const tail = lockPath.split("node_modules/").at(-1) ?? "";
  const parts = tail.split("/");
  return tail.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? "");
}

function npmProductionResolutions(shrinkwrap: NpmShrinkwrap): Map<string, PackageResolution> {
  const resolutions = new Map<string, PackageResolution>();
  for (const [lockPath, record] of Object.entries(shrinkwrap.packages ?? {})) {
    if (lockPath === "" || record.dev) {
      continue;
    }
    const name = record.name ?? packageNameFromLockPath(lockPath);
    assert.ok(name && record.version, `invalid production lock entry ${lockPath}`);
    assert.ok(record.integrity, `${name}@${record.version} has no npm integrity`);
    assert.ok(record.resolved, `${name}@${record.version} has no npm registry URL`);
    const registryUrl = new URL(record.resolved);
    assert.equal(registryUrl.protocol, "https:");
    assert.equal(registryUrl.hostname, "registry.npmjs.org");

    const identity = `${name}@${record.version}`;
    const prior = resolutions.get(identity);
    if (prior) {
      assert.deepEqual(prior, {
        integrity: record.integrity,
        resolved: record.resolved,
      });
    } else {
      resolutions.set(identity, {
        integrity: record.integrity,
        resolved: record.resolved,
      });
    }
  }
  return resolutions;
}

function pnpmPackageIntegrities(lockfile: string): Map<string, string> {
  const integrities = new Map<string, string>();
  let inPackages = false;
  let identity = "";
  for (const line of lockfile.split(/\r?\n/)) {
    if (line === "packages:") {
      inPackages = true;
      continue;
    }
    if (inPackages && line === "snapshots:") {
      break;
    }
    if (!inPackages) {
      continue;
    }

    const key = line.match(/^ {2}(?:'([^']+)'|"([^"]+)"|([^:]+)):\s*$/);
    if (key) {
      identity = key[1] ?? key[2] ?? key[3] ?? "";
      continue;
    }
    const resolution = line.match(/^ {4}resolution: \{integrity: ([^,}]+)[^}]*\}$/);
    if (identity && resolution?.[1]) {
      integrities.set(identity, resolution[1]);
    }
  }
  return integrities;
}

function assertByteIntegrityParity(
  npm: ReadonlyMap<string, PackageResolution>,
  pnpm: ReadonlyMap<string, string>,
): void {
  for (const [identity, resolution] of npm) {
    assert.equal(
      pnpm.get(identity),
      resolution.integrity,
      `package byte-integrity mismatch for ${identity}`,
    );
  }
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

test("npm publishing runs trusted default-branch code after an unprivileged request", () => {
  const request = readWorkflow("release-request.yml");
  const release = readWorkflow("release.yml");
  const jobs = jobBlocks(release);
  const gate = jobs.get("gate") ?? "";
  const build = jobs.get("build") ?? "";
  const publish = jobs.get("publish") ?? "";

  assert.match(request, /name: Release request/);
  assert.match(request, /push:\n\s+tags:\n\s+- "v\*\.\*\.\*"/);
  assert.match(request, /^permissions: \{\}$/m);
  assert.doesNotMatch(
    request,
    /actions\/checkout|contents: write|id-token: write|attestations: write/,
  );

  assert.match(
    release,
    /workflow_run:\n\s+workflows: \["Release request"\]\n\s+types: \[completed\]/,
  );
  assert.deepEqual([...jobs.keys()], ["gate", "build", "publish"]);

  const validate = gate.indexOf("Validate the release request before checkout");
  const checkout = gate.indexOf("actions/checkout");
  assert.ok(validate >= 0 && validate < checkout);
  assert.match(gate, /REQUEST_EVENT: \$\{\{ github\.event\.workflow_run\.event \}\}/);
  assert.match(gate, /REQUEST_CONCLUSION: \$\{\{ github\.event\.workflow_run\.conclusion \}\}/);
  assert.match(gate, /RELEASE_TAG: \$\{\{ github\.event\.workflow_run\.head_branch \}\}/);
  assert.match(gate, /REQUEST_SHA: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/);
  assert.match(gate, /TRUSTED_SHA: \$\{\{ github\.sha \}\}/);
  assert.match(gate, /WORKFLOW_SHA: \$\{\{ github\.workflow_sha \}\}/);
  assert.match(gate, /git\/ref\/tags\/\$\{RELEASE_TAG\}/);
  assert.match(gate, /compare\/\$\{TRUSTED_SHA\}\.\.\.\$\{main_sha\}/);
  assert.match(gate, /REQUEST_SHA.*TRUSTED_SHA.*WORKFLOW_SHA/s);

  assert.match(build, /permissions:\n\s+contents: read/);
  assert.doesNotMatch(build, /id-token/);
  assert.match(build, /actions\/upload-artifact@[0-9a-f]{40}/);

  assert.match(publish, /id-token: write/);
  assert.match(publish, /attestations: write/);
  assert.match(publish, /actions\/download-artifact@[0-9a-f]{40}/);
  assert.doesNotMatch(publish, /run-id:|actions\/checkout|pnpm|npm ci|node scripts/);
});

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
  assert.match(jobs.get("formula") ?? "", /attestations: read/);
  assert.match(jobs.get("formula") ?? "", /persist-credentials: false/);
  assert.doesNotMatch(jobs.get("formula") ?? "", /ref: main/);
  assert.doesNotMatch(jobs.get("formula") ?? "", /pnpm install|npm install|npm ci\b/);

  // `formula-pr` holds the contents-write credential, so it must execute no
  // repository code: no script invocations, no dependency installs, no signing.
  assert.doesNotMatch(jobs.get("formula-pr") ?? "", /id-token/);
  assert.doesNotMatch(jobs.get("formula-pr") ?? "", /node scripts|pnpm|npm install|npm ci\b/);
});

test("the formula pins only verified bytes", () => {
  const jobs = jobBlocks(readWorkflow("release-binaries.yml"));
  const publish = jobs.get("publish") ?? "";
  const formula = jobs.get("formula") ?? "";

  // The binary checksums come from the immutable release's manifest, not from
  // build artifacts that could be swapped between jobs.
  assert.match(formula, /gh release download .*SHA256SUMS/);

  // The npm checksum must not be trust-on-first-use: the tarball has to carry
  // this repository's provenance attestation (created by release.yml before
  // publish) before its sha256 is pinned into the formula.
  assert.match(formula, /gh attestation verify/);
  assert.match(formula, /--repo "\$GH_REPO"/);
  assert.match(formula, /--signer-workflow "\$\{GH_REPO\}\/\.github\/workflows\/release\.yml"/);
  assert.match(formula, /--source-digest "\$VALIDATED_SHA"/);
  assert.match(formula, /--source-ref "refs\/heads\/main"/);
  assert.match(
    publish,
    /Verify exact npm provenance before any release write[\s\S]*VALIDATED_SHA: \$\{\{ needs\.gate\.outputs\.sha \}\}[\s\S]*gh attestation verify/,
  );
  assert.match(
    formula,
    /Wait for the npm tarball[\s\S]*VALIDATED_SHA: \$\{\{ needs\.gate\.outputs\.sha \}\}[\s\S]*gh attestation verify/,
  );
});

test("formula automation rejects versions that do not advance live main", () => {
  const binaryJobs = jobBlocks(readWorkflow("release-binaries.yml"));
  const formula = binaryJobs.get("formula") ?? "";
  const formulaPr = binaryJobs.get("formula-pr") ?? "";
  const gate = binaryJobs.get("gate") ?? "";
  const supplyChain = readWorkflow("supply-chain.yml");
  const policy = jobBlocks(supplyChain).get("policy") ?? "";

  assert.match(formula, /contents\/Formula\/acpx\.rb\?ref=main/);
  assert.match(
    formula,
    /formula-version\.rb\s+\\\n\s+assert-target-advance "\$TARGET_VERSION" "\$current_formula"/,
  );
  assert.match(formula, /baseline-sha256: \$\{\{ steps\.baseline\.outputs\.sha256 \}\}/);
  assert.match(formula, /candidate-sha256: \$\{\{ steps\.render\.outputs\.sha256 \}\}/);

  assert.match(formulaPr, /git fetch --no-tags origin main/);
  assert.match(formulaPr, /EXPECTED_BASELINE_SHA256/);
  assert.match(formulaPr, /EXPECTED_CANDIDATE_SHA256/);
  assert.match(formulaPr, /main changed after version validation/);
  assert.match(formulaPr, /Downloaded formula differs from the parser-validated render/);
  assert.match(formulaPr, /path: \$\{\{ runner\.temp \}\}\/formula/);
  assert.ok(
    formulaPr.indexOf('git checkout -B "$branch" origin/main') <
      formulaPr.indexOf('cp "$candidate" Formula/acpx.rb'),
    "the bot branch must reset to live main before the generated formula enters the worktree",
  );

  assert.match(policy, /Formula version never moves backward/);
  assert.match(policy, /contents\/Formula\/acpx\.rb\?ref=main/);
  assert.match(
    policy,
    /formula-version\.rb\s+\\\n\s+assert-advance Formula\/acpx\.rb "\$main_formula"/,
  );

  // GITHUB_TOKEN-created PRs produce approval-required pull_request runs. The
  // explicit human approval boundary is documented in the generated PR body,
  // and the required main rule prevents merging without this policy job.
  assert.match(supplyChain, /^\s+pull_request:\s*$/m);
  assert.doesNotMatch(supplyChain, /repository_dispatch:/);
  assert.match(formulaPr, /Policy invariants run in an approval-required state/);

  // A stale successful check must stop satisfying main after main advances.
  // The pre-build gate therefore requires the exact context, the GitHub Actions
  // source binding, and strict required-status behavior from the active rules
  // that apply to main.
  assert.match(gate, /rules\/branches\/main\?per_page=100/);
  assert.match(gate, /strict_required_status_checks_policy === true/);
  assert.match(gate, /check\.context === "Policy invariants"/);
  assert.match(gate, /check\.integration_id === 15368/);
  assert.ok(
    gate.indexOf("Require repository release protections") < gate.indexOf("actions/checkout"),
  );
});

test("the attested npm archive installs its locked production closure", () => {
  const release = readWorkflow("release.yml");
  const npmCi = release.indexOf("npm ci --omit=dev --ignore-scripts");
  const typescriptFlowFixture = release.indexOf(
    'flow_smoke="${RUNNER_TEMP}/npm-fallback-smoke.flow.ts"',
  );
  const typescriptFlowSmoke = release.indexOf(
    'node dist/cli.js --format json flow run "$flow_smoke"',
  );

  assert.match(release, /tar -xzf "\$TARBALL"/);
  assert.match(release, /npm-shrinkwrap\.json/);
  assert.match(release, /npm ci[\s\S]*--omit=dev[\s\S]*--ignore-scripts/);
  assert.match(release, /node dist\/cli\.js --version/);
  assert.ok(
    npmCi >= 0 && npmCi < typescriptFlowFixture && typescriptFlowFixture < typescriptFlowSmoke,
    "the installed npm fallback must run a RUNNER_TEMP TypeScript flow smoke after npm ci",
  );
  assert.match(release, /enum NpmFallbackSmoke/);
  assert.match(release, /payload\.action !== "flow_run_result"/);
  assert.match(release, /payload\.status !== "completed"/);
  assert.match(release, /payload\.outputs\?\.prove_typescript !== "locked"/);
  assert.match(release, /pnpm --filter acpx deploy[\s\S]*?--prod[\s\S]*?--ignore-scripts/);
  assert.match(release, /npm and pnpm production dependency closures differ/);
  assert.match(release, /package byte-integrity mismatch/);
  assert.match(release, /registry\.npmjs\.org/);
  assert.match(release, /resolution: \\\{integrity:/);
  assert.match(release, /"dir:\$\{RUNNER_TEMP\}\/npm-tree"/);
  assert.match(release, /@agentclientprotocol\/claude-agent-acp/);
  assert.match(release, /@agentclientprotocol\/codex-acp/);
  assert.match(release, /@agentclientprotocol\/sdk/);
  assert.match(release, /@stryker-mutator\/core/);
  assert.match(release, /oxlint/);
  assert.match(release, /vite/);
  assert.doesNotMatch(release, /cp package\.json pnpm-lock\.yaml pnpm-workspace\.yaml/);
});

test("npm pack ships a production shrinkwrap whose root matches package.json", (t) => {
  const packed = packProject(t);

  assert.ok(
    packed.files.includes("npm-shrinkwrap.json"),
    "the published archive must include npm-shrinkwrap.json",
  );
  const manifest = JSON.parse(
    readFileSync(path.join(packed.packageDir, "package.json"), "utf8"),
  ) as {
    dependencies?: Record<string, string>;
  };
  const shrinkwrap = JSON.parse(
    readFileSync(path.join(packed.packageDir, "npm-shrinkwrap.json"), "utf8"),
  ) as {
    lockfileVersion?: number;
    packages?: Record<string, { dependencies?: Record<string, string> }>;
  };

  assert.equal(shrinkwrap.lockfileVersion, 3);
  assert.deepEqual(shrinkwrap.packages?.[""]?.dependencies, manifest.dependencies);
});

test("npm and pnpm production locks bind matching registry bytes", () => {
  const shrinkwrap = JSON.parse(readFileSync("npm-shrinkwrap.json", "utf8")) as NpmShrinkwrap;
  const npm = npmProductionResolutions(shrinkwrap);
  const pnpm = pnpmPackageIntegrities(readFileSync("pnpm-lock.yaml", "utf8"));

  assert.ok(npm.size > 100, "expected a non-trivial production closure");
  assertByteIntegrityParity(npm, pnpm);

  const [identity, resolution] =
    [...npm].find(([candidate]) => pnpm.has(candidate)) ?? assert.fail("no shared package");
  const tampered = new Map(npm);
  tampered.set(identity, { ...resolution, integrity: "sha512-tampered" });
  assert.throws(() => assertByteIntegrityParity(tampered, pnpm), /package byte-integrity mismatch/);
});

test("npm ci rejects a packed archive when its shrinkwrap is omitted", (t) => {
  const packed = packProject(t);
  const shrinkwrapPath = path.join(packed.packageDir, "npm-shrinkwrap.json");
  renameSync(shrinkwrapPath, `${shrinkwrapPath}.removed`);

  const result = spawnSync(
    "npm",
    ["ci", "--omit=dev", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"],
    {
      cwd: packed.packageDir,
      encoding: "utf8",
      env: {
        ...process.env,
        npm_config_cache: packed.npmCache,
        npm_config_update_notifier: "false",
      },
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /can only install[\s\S]*npm-shrinkwrap\.json with lockfileVersion/,
  );
});

test("the npm SBOM generator is immutable and removes nondeterministic metadata", () => {
  const release = readWorkflow("release.yml");

  assert.doesNotMatch(release, /anchore\/sbom-action/);
  assert.match(release, /SYFT_VERSION: 1\.44\.0/);
  assert.match(release, /SYFT_LINUX_AMD64_SHA256: [0-9a-f]{64}/);
  assert.match(release, /releases\/download\/v\$\{SYFT_VERSION\}/);
  assert.match(release, /sha256sum --check/);
  assert.match(release, /"\$\{RUNNER_TEMP\}\/syft\/syft"/);
  assert.match(release, /delete bom\.serialNumber/);
  assert.match(release, /delete bom\.metadata\.timestamp/);
});

test("binary releases fail closed unless repository release protections are enabled", () => {
  const gate = jobBlocks(readWorkflow("release-binaries.yml")).get("gate") ?? "";

  assert.match(gate, /repos\/\$\{GH_REPO\}\/immutable-releases/);
  assert.match(gate, /X-GitHub-Api-Version: 2026-03-10/);
  assert.match(
    gate,
    /Require repository release protections[\s\S]*?GH_TOKEN: \$\{\{ secrets\.RELEASE_SETTINGS_READER \}\}[\s\S]*?repos\/\$\{GH_REPO\}\/immutable-releases/,
  );
  assert.match(gate, /if \[ -z "\$GH_TOKEN" \]/);
  assert.match(gate, /if \[ "\$enabled" != "true" \]/);
});

test("action pin comments are verified against the referenced tags", () => {
  const policy = jobBlocks(readWorkflow("supply-chain.yml")).get("policy") ?? "";

  assert.match(policy, /git\/ref\/tags\/\$\{tag\}/);
  assert.match(policy, /git\/tags\/\$\{tag_sha\}/);
  assert.match(policy, /\[ "\$resolved_sha" != "\$sha" \]/);
});

test("every release stage stays bound to the gate-validated commit", () => {
  const jobs = jobBlocks(readWorkflow("release-binaries.yml"));
  const gate = jobs.get("gate") ?? "";
  const build = jobs.get("build") ?? "";
  const publish = jobs.get("publish") ?? "";
  const formula = jobs.get("formula") ?? "";

  // repository_dispatch runs the default branch's workflow. The selected tag,
  // trusted event commit, and workflow revision must all be the same commit.
  assert.match(gate, /TRUSTED_SHA: \$\{\{ github\.sha \}\}/);
  assert.match(gate, /WORKFLOW_SHA: \$\{\{ github\.workflow_sha \}\}/);
  assert.match(gate, /tag_sha.*TRUSTED_SHA.*WORKFLOW_SHA/s);
  assert.match(gate, /sha=\$\{TRUSTED_SHA\}/);

  // Matrix jobs and formula rendering consume the immutable SHA output, never
  // independently resolve the still-mutable tag.
  assert.match(build, /ref: \$\{\{ needs\.gate\.outputs\.sha \}\}/);
  assert.match(formula, /ref: \$\{\{ needs\.gate\.outputs\.sha \}\}/);
  assert.doesNotMatch(build, /ref: \$\{\{ inputs\.tag/);

  // The final writer dereferences the remote tag both before draft work and
  // again after upload, immediately before immutable publication freezes it.
  assert.match(publish, /git\/ref\/tags\/\$\{TAG\}/);
  assert.match(publish, /git\/tags\/\$\{object_sha\}/);
  assert.match(publish, /object_sha.*VALIDATED_SHA/);
  assert.equal(publish.match(/^\s+assert_tag_matches$/gm)?.length, 2);
  const upload = publish.indexOf("gh release upload");
  const finalTagCheck = publish.lastIndexOf("assert_tag_matches");
  const publishLive = publish.indexOf("gh release edit");
  assert.ok(upload < finalTagCheck && finalTagCheck < publishLive);
});

test("binary publishing runs default-branch workflow code for an exact dispatch tag", () => {
  const workflow = readWorkflow("release-binaries.yml");
  const gate = jobBlocks(workflow).get("gate") ?? "";

  assert.match(workflow, /repository_dispatch:\n\s+types: \[release-binaries\]/);
  assert.doesNotMatch(workflow, /workflow_dispatch:/);
  assert.match(workflow, /client_payload\.tag/);

  const validate = gate.indexOf("Validate the dispatch before checkout");
  const checkout = gate.indexOf("actions/checkout");
  assert.ok(validate >= 0 && validate < checkout);
  assert.match(gate, /TRUSTED_SHA: \$\{\{ github\.sha \}\}/);
  assert.match(gate, /WORKFLOW_SHA: \$\{\{ github\.workflow_sha \}\}/);
  assert.match(gate, /RELEASE_TAG: \$\{\{ github\.event\.client_payload\.tag \}\}/);
  assert.match(gate, /git\/ref\/tags\/\$\{RELEASE_TAG\}/);
  assert.match(gate, /compare\/\$\{TRUSTED_SHA\}\.\.\.\$\{main_sha\}/);
  assert.match(gate, /tag_sha.*TRUSTED_SHA.*WORKFLOW_SHA/s);
});

test("binary publishing verifies the exact npm provenance before any release write", () => {
  const publish = jobBlocks(readWorkflow("release-binaries.yml")).get("publish") ?? "";
  const verifyStart = publish.indexOf("Verify exact npm provenance before any release write");
  const verifyEnd = publish.indexOf("\n      - name:", verifyStart + 1);
  const verify = publish.slice(verifyStart, verifyEnd);

  assert.match(verify, /GH_REPO: \$\{\{ github\.repository \}\}/);
  assert.match(publish, /gh attestation verify/);
  assert.match(publish, /--repo "\$GH_REPO"/);
  assert.match(publish, /--signer-workflow "\$\{GH_REPO\}\/\.github\/workflows\/release\.yml"/);
  assert.match(publish, /--source-digest "\$VALIDATED_SHA"/);
  assert.match(publish, /--source-ref "refs\/heads\/main"/);
  assert.ok(
    publish.indexOf("gh attestation verify") < publish.indexOf("gh release create"),
    "npm provenance must be verified before the draft is created",
  );
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

  // The gate requires immutable releases before any build starts, so assets
  // and the Git tag freeze at publication. Creating a published release and
  // uploading into it afterwards cannot work.
  const draftCreate = publish.indexOf("gh release create");
  const upload = publish.indexOf("gh release upload");
  const flipLive = publish.indexOf("--draft=false");

  assert.ok(draftCreate !== -1 && upload !== -1 && flipLive !== -1);
  assert.ok(draftCreate < upload, "the draft must exist before assets are uploaded");
  assert.ok(upload < flipLive, "assets must be attached before the draft is published");
  assert.match(publish.slice(draftCreate, upload), /--draft\b/);
  assert.match(publish.slice(draftCreate, upload), /--verify-tag\b/);

  // Replacing an asset would swap bytes that were already attested.
  assert.doesNotMatch(publish, /--clobber/);
  assert.match(publish, /already exists.*Delete the existing draft or cut a new version/is);
  assert.match(publish, /expected_assets/);
  assert.match(publish, /actual_assets/);
  assert.match(publish, /draft=true/);
  assert.match(publish, /prerelease=false/);
  assert.match(publish, /tagName/);
  assert.match(publish, /title=\$TAG/);
  assert.doesNotMatch(publish, /targetCommitish/);
});

test("npm publish rechecks the live remote tag against the frozen workflow commit", () => {
  const release = jobBlocks(readWorkflow("release.yml")).get("publish") ?? "";

  assert.match(release, /GH_REPO: \$\{\{ github\.repository \}\}/);
  assert.match(release, /RELEASE_SHA: \$\{\{ needs\.gate\.outputs\.sha \}\}/);
  assert.match(release, /git\/ref\/tags\/\$\{RELEASE_TAG\}/);
  assert.match(release, /git\/tags\/\$\{object_sha\}/);
  assert.match(release, /object_sha.*RELEASE_SHA/);

  const finalTagCheck = release.lastIndexOf("assert_tag_matches");
  const publish = release.lastIndexOf("npm publish");
  assert.ok(finalTagCheck >= 0 && finalTagCheck < publish);
  assert.match(release.slice(publish), /--ignore-scripts/);
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

test("the SEA embeds complete runtime assets for dynamic flow loading", () => {
  const buildScript = readFileSync(path.join(process.cwd(), "scripts", "sea", "build.mjs"), "utf8");
  const seaConfig = readFileSync(
    path.join(process.cwd(), "scripts", "sea", "sea-config.json"),
    "utf8",
  );
  const delegatedConfig = readFileSync(
    path.join(process.cwd(), "scripts", "sea", "tsdown.runtime.config.ts"),
    "utf8",
  );
  const flowConfig = readFileSync(
    path.join(process.cwd(), "scripts", "sea", "tsdown.flow-runtime.config.ts"),
    "utf8",
  );

  assert.match(buildScript, /tsdown\.runtime\.config\.ts/);
  assert.match(buildScript, /tsdown\.flow-runtime\.config\.ts/);
  assert.match(seaConfig, /"acpx-flow-cli": "dist-sea\/runtime\/delegated-entry\.cjs"/);
  assert.match(seaConfig, /"acpx-flow-runtime": "dist-sea\/runtime\/flows\.js"/);
  assert.match(
    delegatedConfig,
    /deps:\s*\{[\s\S]*alwaysBundle: \[\/\.\*\/\][\s\S]*neverBundle: \["esbuild"\][\s\S]*\}/,
  );
  assert.match(delegatedConfig, /codeSplitting: false/);
  assert.match(flowConfig, /deps: \{ alwaysBundle: \[\/\.\*\/\] \}/);
  assert.match(flowConfig, /codeSplitting: false/);
});
