#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const outDir = path.join(repoRoot, "dist-sea");
const bundlePath = path.join(outDir, "entry.cjs");
const blobPath = path.join(outDir, "acpx-sea.blob");
const binaryPath = path.join(outDir, "acpx");

// Matches the fuse string Node compiles into its own binary.
const SENTINEL_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

/**
 * `useSnapshot` runs the main script through Node's minimalRunCjs, which does
 * not provide the CommonJS wrapper. The bundle never writes to `exports` at top
 * level, so this only has to satisfy rolldown's prologue — and it must not
 * clobber a real `module` binding if one exists.
 */
const CJS_WRAPPER_SHIM =
  "var module = typeof module === 'undefined' ? { exports: {} } : module;\n" +
  "var exports = module.exports;\n";

function run(command, args) {
  execFileSync(command, args, { cwd: repoRoot, stdio: "inherit" });
}

/**
 * Homebrew's Node is built with single-executable support compiled out, so fail
 * with an actionable message rather than an opaque execFileSync throw.
 */
function assertSeaCapable(nodePath) {
  const enabled = execFileSync(
    nodePath,
    ["-p", "String(process.config.variables.single_executable_application)"],
    { encoding: "utf8" },
  ).trim();
  if (enabled !== "true") {
    throw new Error(
      `${nodePath} was built without single-executable support.\n` +
        "Point ACPX_SEA_NODE at an official nodejs.org build, e.g.\n" +
        "  ACPX_SEA_NODE=~/.local/share/nvm/v24.11.0/bin/node node scripts/sea/build.mjs",
    );
  }
}

const seaNode = process.env.ACPX_SEA_NODE ?? process.execPath;
assertSeaCapable(seaNode);

run("npx", ["tsdown", "-c", path.join(here, "tsdown.sea.config.ts")]);

fs.writeFileSync(bundlePath, CJS_WRAPPER_SHIM + fs.readFileSync(bundlePath, "utf8"));

run(seaNode, ["--experimental-sea-config", path.join(here, "sea-config.json")]);

// Inject the blob into a copy of the host Node binary.
fs.copyFileSync(seaNode, binaryPath);
fs.chmodSync(binaryPath, 0o755);

if (process.platform === "darwin") {
  run("codesign", ["--remove-signature", binaryPath]);
}

run("npx", [
  "postject",
  binaryPath,
  "NODE_SEA_BLOB",
  blobPath,
  "--sentinel-fuse",
  SENTINEL_FUSE,
  ...(process.platform === "darwin" ? ["--macho-segment-name", "NODE_SEA"] : []),
]);

if (process.platform === "darwin") {
  run("codesign", ["--sign", "-", binaryPath]);
}

process.stdout.write(`\nBuilt ${binaryPath}\n`);
