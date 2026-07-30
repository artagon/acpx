import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

const SEA_BUILD_SCRIPT = path.join(process.cwd(), "scripts", "sea", "build.mjs");

function runBuildUntilPnpm(
  t: TestContext,
  seaNodeVersionOverride?: string,
): {
  result: ReturnType<typeof spawnSync>;
  capturedVersion: string | undefined;
  pnpmCalled: boolean;
} {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "acpx-sea-build-test-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const capturePath = path.join(tempDir, "sea-node-version");
  const fakePnpmPath = path.join(tempDir, "pnpm");
  writeFileSync(
    fakePnpmPath,
    [
      "#!/bin/sh",
      'printf "%s" "${ACPX_SEA_NODE_VERSION-}" > "$ACPX_TEST_VERSION_CAPTURE"',
      "exit 42",
      "",
    ].join("\n"),
  );
  chmodSync(fakePnpmPath, 0o755);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ACPX_SEA_NODE: process.execPath,
    ACPX_TEST_VERSION_CAPTURE: capturePath,
    PATH: `${tempDir}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  if (seaNodeVersionOverride === undefined) {
    delete env.ACPX_SEA_NODE_VERSION;
  } else {
    env.ACPX_SEA_NODE_VERSION = seaNodeVersionOverride;
  }

  const result = spawnSync(process.execPath, [SEA_BUILD_SCRIPT], {
    cwd: process.cwd(),
    encoding: "utf8",
    env,
  });

  return {
    result,
    capturedVersion: existsSync(capturePath) ? readFileSync(capturePath, "utf8") : undefined,
    pnpmCalled: existsSync(capturePath),
  };
}

test("SEA build labels the SBOM with the selected Node executable version", (t) => {
  const run = runBuildUntilPnpm(t);

  assert.notEqual(run.result.status, 0);
  assert.equal(run.capturedVersion, process.versions.node);
});

test("SEA build rejects a Node version override that disagrees with the selected executable", (t) => {
  const run = runBuildUntilPnpm(t, "0.0.0");
  const stderr = String(run.result.stderr);

  assert.notEqual(run.result.status, 0);
  assert.equal(run.pnpmCalled, false);
  assert.match(stderr, /ACPX_SEA_NODE_VERSION 0\.0\.0 does not match/);
  assert.match(stderr, new RegExp(process.versions.node.replaceAll(".", "\\.")));
});
