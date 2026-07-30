import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const fixtures = path.join(root, "test", "fixtures", "release-policy");
const ageVerifier = path.join(root, "scripts", "supply-chain", "verify-release-age.mjs");
const formulaValidator = path.join(root, "scripts", "release", "formula-version.rb");

function combinedOutput(result: SpawnSyncReturns<string>): string {
  return `${result.stdout}\n${result.stderr}`;
}

function verifyAge(metadata: string, workspace = "workspace.yaml"): SpawnSyncReturns<string> {
  return spawnSync(
    process.execPath,
    [
      ageVerifier,
      "--lockfile",
      path.join(fixtures, "pnpm-lock.yaml"),
      "--workspace",
      path.join(fixtures, workspace),
      "--metadata",
      path.join(fixtures, metadata),
      "--now",
      "2026-07-29T12:00:00.000Z",
      "--minimum-age-minutes",
      "2880",
    ],
    { encoding: "utf8" },
  );
}

function formula(...args: string[]): SpawnSyncReturns<string> {
  return spawnSync("ruby", [formulaValidator, ...args], { encoding: "utf8" });
}

test("release-age verification rejects a fresh dependency from a frozen lockfile", () => {
  const result = verifyAge("metadata-fresh.json");

  assert.notEqual(result.status, 0);
  assert.match(combinedOutput(result), /fresh-package@2\.0\.0.*younger than 2880 minutes/is);
});

test("release-age verification checks every registry package and accepts an aged closure", () => {
  const missing = verifyAge("metadata-missing.json");
  assert.notEqual(missing.status, 0);
  assert.match(combinedOutput(missing), /fresh-package@2\.0\.0.*publish time/is);

  const aged = verifyAge("metadata-aged.json");
  assert.equal(aged.status, 0, combinedOutput(aged));
  assert.match(aged.stdout, /Verified 2 locked registry dependencies/);
});

test("release-age verification rejects exclusion configuration", () => {
  for (const workspace of [
    "workspace-excluded.yaml",
    "workspace-aliased-exclusion.yaml",
    path.join("npmrc-excluded", "workspace.yaml"),
  ]) {
    const result = verifyAge("metadata-aged.json", workspace);

    assert.notEqual(result.status, 0, `${workspace} unexpectedly passed`);
    assert.match(combinedOutput(result), /minimumReleaseAge|minimum-release-age/i);
    assert.match(combinedOutput(result), /not allowed|must not/i);
  }
});

test("formula validation rejects duplicate and block-comment-hidden declarations", () => {
  const valid = formula("extract", path.join(fixtures, "formula-valid.rb"));
  assert.equal(valid.status, 0, combinedOutput(valid));
  assert.equal(valid.stdout.trim(), "1.2.3");

  for (const fixture of [
    "formula-duplicate.rb",
    "formula-parenthesized-duplicate.rb",
    "formula-dynamic-duplicate.rb",
    "formula-block-comment-decoy.rb",
    "formula-condition-hidden.rb",
    "formula-version-override.rb",
    "formula-version-alias.rb",
    "formula-version-symbol-alias.rb",
    "formula-version-undef.rb",
    "formula-version-symbol-undef.rb",
    "formula-version-define-method.rb",
  ]) {
    const result = formula("extract", path.join(fixtures, fixture));
    assert.notEqual(result.status, 0, `${fixture} unexpectedly passed`);
    assert.match(
      combinedOutput(result),
      /exactly one canonical version declaration|does not allow dynamic Ruby evaluation|direct Formula class statement|must not redefine version/is,
    );
  }
});

test("formula advancement compares the parser-validated effective versions", () => {
  const current = path.join(fixtures, "formula-block-comment-decoy.rb");
  const candidate = path.join(fixtures, "formula-valid.rb");

  const hostile = formula("assert-advance", candidate, current);
  assert.notEqual(hostile.status, 0);
  assert.match(combinedOutput(hostile), /exactly one canonical version declaration/is);

  const target = formula("assert-target-advance", "1.2.4", candidate);
  assert.equal(target.status, 0, combinedOutput(target));

  const downgrade = formula("assert-target-advance", "1.2.3", candidate);
  assert.notEqual(downgrade.status, 0);
  assert.match(combinedOutput(downgrade), /must be strictly greater/i);
});

test("release workflows run the effective 48-hour lockfile gate before installs", () => {
  const supplyChain = readFileSync(
    path.join(root, ".github", "workflows", "supply-chain.yml"),
    "utf8",
  );
  const npmRelease = readFileSync(path.join(root, ".github", "workflows", "release.yml"), "utf8");
  const binaryRelease = readFileSync(
    path.join(root, ".github", "workflows", "release-binaries.yml"),
    "utf8",
  );
  const command = "node scripts/supply-chain/verify-release-age.mjs --minimum-age-minutes 2880";

  assert.match(supplyChain, new RegExp(command.replaceAll(".", String.raw`\.`)));
  assert.ok(supplyChain.indexOf(command) < supplyChain.indexOf("pnpm install --frozen-lockfile"));
  assert.ok(npmRelease.indexOf(command) < npmRelease.indexOf("pnpm install --frozen-lockfile"));
  assert.ok(
    binaryRelease.indexOf(command) < binaryRelease.indexOf("pnpm install --frozen-lockfile"),
  );
});

test("formula workflows share the non-executing validator without running it in the writer job", () => {
  const binaryRelease = readFileSync(
    path.join(root, ".github", "workflows", "release-binaries.yml"),
    "utf8",
  );
  const supplyChain = readFileSync(
    path.join(root, ".github", "workflows", "supply-chain.yml"),
    "utf8",
  );
  const formulaPrStart = binaryRelease.indexOf("\n  formula-pr:");
  const formulaPr = binaryRelease.slice(formulaPrStart);

  assert.match(binaryRelease, /ruby scripts\/release\/formula-version\.rb/);
  assert.match(supplyChain, /ruby scripts\/release\/formula-version\.rb/);
  assert.match(formulaPr, /EXPECTED_BASELINE_SHA256/);
  assert.match(formulaPr, /EXPECTED_CANDIDATE_SHA256/);
  assert.doesNotMatch(formulaPr, /ruby scripts\/release|node scripts\//);
});
