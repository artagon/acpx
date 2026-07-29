import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

const GENERATOR = path.join(process.cwd(), "scripts", "sea", "generate-formula.mjs");
const VERSION = "1.2.3";
const NPM_SHA = "a".repeat(64);

type GeneratorResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  formulaPath: string;
};

function runGenerator(
  t: TestContext,
  sums: string,
  extraArgs: readonly string[] = [],
  version = VERSION,
  npmSha = NPM_SHA,
): GeneratorResult {
  const dir = mkdtempSync(path.join(os.tmpdir(), "acpx-formula-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const sumsPath = path.join(dir, "SHA256SUMS");
  const formulaPath = path.join(dir, "acpx.rb");
  writeFileSync(sumsPath, sums);

  const result = spawnSync(
    process.execPath,
    [
      GENERATOR,
      "--version",
      version,
      "--npm-sha256",
      npmSha,
      "--sums",
      sumsPath,
      "--out",
      formulaPath,
      ...extraArgs,
    ],
    { encoding: "utf8" },
  );

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    formulaPath,
  };
}

function tarballLine(target: string, sha = "b".repeat(64), version = VERSION): string {
  return `${sha}  acpx-${version}-${target}.tar.gz`;
}

test("generator emits upstream URLs and explicit release-layout checks", (t) => {
  const result = runGenerator(
    t,
    [
      tarballLine("darwin-arm64", "1".repeat(64)),
      tarballLine("darwin-x64", "2".repeat(64)),
      tarballLine("linux-arm64", "3".repeat(64)),
      tarballLine("linux-x64", "4".repeat(64)),
      `${"5".repeat(64)}  acpx-${VERSION}-darwin-arm64.tar.gz.cdx.json`,
      "",
    ].join("\n"),
  );

  assert.equal(result.status, 0, result.stderr);
  const formula = readFileSync(result.formulaPath, "utf8");
  assert.match(formula, /homepage "https:\/\/github\.com\/openclaw\/acpx"/);
  assert.match(formula, /https:\/\/github\.com\/openclaw\/acpx\/releases\/download\/v1\.2\.3\//);
  assert.doesNotMatch(formula, /artagon\/acpx/);
  assert.match(formula, /npm_layout = \(buildpath\/"package\.json"\)\.file\?/);
  assert.match(
    formula,
    /binary_layout = \(buildpath\/"acpx"\)\.file\? && \(buildpath\/"acpx"\)\.executable\?/,
  );
  assert.match(formula, /Ambiguous acpx release layout/);
  assert.match(formula, /Unknown acpx release layout/);
});

test("generator keeps Node for adapter subprocesses and omits missing binary slots", (t) => {
  const result = runGenerator(t, `${tarballLine("darwin-arm64")}\n`);

  assert.equal(result.status, 0, result.stderr);
  const formula = readFileSync(result.formulaPath, "utf8");
  assert.match(formula, /^\s+depends_on "node"$/m);
  assert.match(formula, /on_arm do\n\s+url .*darwin-arm64/);
  assert.doesNotMatch(formula, /on_intel do/);
  assert.doesNotMatch(formula, /on_linux do/);
});

test("generator rejects duplicate target checksums", (t) => {
  const result = runGenerator(
    t,
    `${tarballLine("linux-x64", "1".repeat(64))}\n${tarballLine("linux-x64", "2".repeat(64))}\n`,
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Duplicate tarball for target "linux-x64"/);
});

test("generator rejects an asset from a different version", (t) => {
  const result = runGenerator(t, `${tarballLine("linux-x64", "b".repeat(64), "9.9.9")}\n`);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /is for version 9\.9\.9, expected 1\.2\.3/);
});

test("generator rejects unknown targets", (t) => {
  const result = runGenerator(t, `${tarballLine("plan9-amd64")}\n`);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /names unknown target "plan9-amd64"/);
});

test("generator rejects manifests without binary tarballs", (t) => {
  const result = runGenerator(t, `${"c".repeat(64)}  acpx-${VERSION}-linux-x64.tar.gz.cdx.json\n`);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /lists no acpx tarballs/);
});

test("generator rejects malformed checksum lines", (t) => {
  const result = runGenerator(t, "not-a-checksum\n");

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unparseable checksum line/);
});

test("generator rejects duplicate arguments instead of silently taking the last value", (t) => {
  const result = runGenerator(t, `${tarballLine("linux-x64")}\n`, ["--version", "4.5.6"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Duplicate argument --version/);
});

test("generator validates version and npm checksum inputs", (t) => {
  const invalidVersion = runGenerator(t, `${tarballLine("linux-x64")}\n`, [], "not-semver");
  assert.notEqual(invalidVersion.status, 0);
  assert.match(invalidVersion.stderr, /--version must be X\.Y\.Z/);

  const invalidSha = runGenerator(t, `${tarballLine("linux-x64")}\n`, [], VERSION, "short");
  assert.notEqual(invalidSha.status, 0);
  assert.match(invalidSha.stderr, /--npm-sha256 must be 64 hex characters/);
});
