import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

const GENERATOR = path.join(process.cwd(), "scripts", "sea", "generate-formula.mjs");
const CHECKED_FORMULA = path.join(process.cwd(), "Formula", "acpx.rb");
const VERSION = "1.2.3";
const NPM_SHA = "a".repeat(64);

type GeneratorResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  formulaPath: string;
};

function invokeGenerator(
  t: TestContext,
  argsFor: (dir: string, formulaPath: string) => readonly string[],
): GeneratorResult {
  const dir = mkdtempSync(path.join(os.tmpdir(), "acpx-formula-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const formulaPath = path.join(dir, "acpx.rb");
  const result = spawnSync(process.execPath, [GENERATOR, ...argsFor(dir, formulaPath)], {
    encoding: "utf8",
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    formulaPath,
  };
}

function runGenerator(
  t: TestContext,
  sums: string,
  extraArgs: readonly string[] = [],
  version = VERSION,
  npmSha = NPM_SHA,
): GeneratorResult {
  return invokeGenerator(t, (dir, formulaPath) => {
    const sumsPath = path.join(dir, "SHA256SUMS");
    writeFileSync(sumsPath, sums);
    return [
      "--version",
      version,
      "--npm-sha256",
      npmSha,
      "--sums",
      sumsPath,
      "--out",
      formulaPath,
      ...extraArgs,
    ];
  });
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

test("generator requires --sums before reading the checksum manifest", (t) => {
  const result = invokeGenerator(t, (_dir, formulaPath) => [
    "--version",
    VERSION,
    "--npm-sha256",
    NPM_SHA,
    "--out",
    formulaPath,
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--sums is required and must name a checksum manifest/);
  assert.doesNotMatch(result.stderr, /ENOENT/);
});

test("generator rejects a missing --sums file with its path and remediation", (t) => {
  const result = invokeGenerator(t, (dir, formulaPath) => {
    const missingPath = path.join(dir, "missing-SHA256SUMS");
    return [
      "--version",
      VERSION,
      "--npm-sha256",
      NPM_SHA,
      "--sums",
      missingPath,
      "--out",
      formulaPath,
    ];
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--sums file does not exist:/);
  assert.match(result.stderr, /missing-SHA256SUMS/);
  assert.match(result.stderr, /Download or generate SHA256SUMS before rendering the formula/);
  assert.doesNotMatch(result.stderr, /ENOENT/);
});

test("generator rejects a --sums path that is not a regular file", (t) => {
  const result = invokeGenerator(t, (dir, formulaPath) => [
    "--version",
    VERSION,
    "--npm-sha256",
    NPM_SHA,
    "--sums",
    dir,
    "--out",
    formulaPath,
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--sums must name a regular file/);
  assert.doesNotMatch(result.stderr, /EISDIR/);
});

test("generated npm fallbacks require the shipped shrinkwrap and enforce it with npm ci", (t) => {
  const result = runGenerator(t, `${tarballLine("linux-x64")}\n`);

  assert.equal(result.status, 0, result.stderr);
  const formula = readFileSync(result.formulaPath, "utf8");
  assert.match(formula, /npm-shrinkwrap\.json/);
  assert.match(formula, /system "npm", "ci", "--omit=dev", \*std_npm_args\(prefix: false\)/);
  assert.doesNotMatch(formula, /system "npm", "install"/);
  assert.match(formula, /libexec\.install Dir\["\*"\]/);
  assert.match(formula, /bin\.install_symlink libexec\/"dist\/cli\.js" => "acpx"/);
});

test("the checked v0.12.1 formula marks its dynamic npm fallback as legacy-only", () => {
  const formula = readFileSync(CHECKED_FORMULA, "utf8");

  assert.match(formula, /version "0\.12\.1"/);
  assert.match(formula, /fallback remains\s+# legacy-only/s);
  assert.match(formula, /system "npm", "install", \*std_npm_args/);
  assert.doesNotMatch(formula, /exact production dependency bytes/);
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
