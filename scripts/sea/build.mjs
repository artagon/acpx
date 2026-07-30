#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PackageURL } from "packageurl-js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const outDir = path.join(repoRoot, "dist-sea");
const bundlePath = path.join(outDir, "entry.cjs");
const blobPath = path.join(outDir, "acpx-sea.blob");
const binaryPath = path.join(outDir, "acpx");
const sbomPath = path.join(outDir, "sbom.json");
const moduleRequire = createRequire(import.meta.url);

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

function run(command, args, env = process.env) {
  execFileSync(command, args, { cwd: repoRoot, env, stdio: "inherit" });
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

function readSeaNodeVersion(nodePath) {
  const version = execFileSync(nodePath, ["-p", "process.versions.node"], {
    encoding: "utf8",
  })
    .trim()
    .replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+(?:[-+].+)?$/u.test(version)) {
    throw new Error(`Unable to determine a valid Node.js version from ${nodePath}: ${version}`);
  }
  return version;
}

function resolveSeaNodeVersion(nodePath, configuredVersion) {
  const actualVersion = readSeaNodeVersion(nodePath);
  if (configuredVersion !== undefined) {
    const normalizedConfigured = configuredVersion.trim().replace(/^v/, "");
    if (normalizedConfigured !== actualVersion) {
      throw new Error(
        `ACPX_SEA_NODE_VERSION ${configuredVersion} does not match ${nodePath} (${actualVersion}).`,
      );
    }
  }
  return actualVersion;
}

function materializeFlowRuntimeEsbuild() {
  const platformPackages = {
    "darwin-arm64": "@esbuild/darwin-arm64",
    "darwin-x64": "@esbuild/darwin-x64",
    "linux-arm64": "@esbuild/linux-arm64",
    "linux-x64": "@esbuild/linux-x64",
  };
  const target = `${process.platform}-${process.arch}`;
  const platformPackage = platformPackages[target];
  if (!platformPackage) {
    throw new Error(`Unsupported SEA esbuild target: ${target}`);
  }

  const tsxPackagePath = moduleRequire.resolve("tsx/package.json");
  const tsxRequire = createRequire(tsxPackagePath);
  const esbuildPackagePath = tsxRequire.resolve("esbuild/package.json");
  const esbuildRequire = createRequire(esbuildPackagePath);
  const esbuildMetadata = JSON.parse(fs.readFileSync(esbuildPackagePath, "utf8"));
  const esbuildMainPath = path.join(path.dirname(esbuildPackagePath), "lib", "main.js");
  const esbuildBinaryPath = esbuildRequire.resolve(`${platformPackage}/bin/esbuild`);
  const platformPackagePath = esbuildRequire.resolve(`${platformPackage}/package.json`);
  const platformMetadata = JSON.parse(fs.readFileSync(platformPackagePath, "utf8"));
  const runtimeEsbuildDir = path.join(outDir, "runtime", "node_modules", "esbuild");
  const runtimeEsbuildMainDir = path.join(runtimeEsbuildDir, "lib");
  const runtimeEsbuildBinaryPath = path.join(outDir, "runtime", "esbuild");

  fs.mkdirSync(runtimeEsbuildMainDir, { recursive: true });
  fs.copyFileSync(esbuildPackagePath, path.join(runtimeEsbuildDir, "package.json"));
  fs.copyFileSync(esbuildMainPath, path.join(runtimeEsbuildMainDir, "main.js"));
  fs.copyFileSync(esbuildBinaryPath, runtimeEsbuildBinaryPath);
  fs.chmodSync(runtimeEsbuildBinaryPath, 0o755);

  if (esbuildMetadata.version !== platformMetadata.version) {
    throw new Error(
      `esbuild runtime version mismatch: ${esbuildMetadata.version} != ${platformMetadata.version}`,
    );
  }

  return {
    esbuildVersion: esbuildMetadata.version,
    platformMetadata,
    runtimeEsbuildBinaryPath,
  };
}

function addFlowRuntimeEsbuildToSbom(sbom, runtimeEsbuild) {
  const components = sbom.components ?? [];
  const esbuildComponent = components.find(
    (component) =>
      component.name === "esbuild" && component.version === runtimeEsbuild.esbuildVersion,
  );
  if (!esbuildComponent || typeof esbuildComponent["bom-ref"] !== "string") {
    throw new Error(
      `${sbomPath} does not identify esbuild ${runtimeEsbuild.esbuildVersion} used by the SEA flow runtime.`,
    );
  }

  const platformPackageName = runtimeEsbuild.platformMetadata.name;
  const separator = platformPackageName.lastIndexOf("/");
  const platformGroup = platformPackageName.slice(0, separator);
  const platformName = platformPackageName.slice(separator + 1);
  const platformPurl = new PackageURL(
    "npm",
    platformGroup,
    platformName,
    runtimeEsbuild.platformMetadata.version,
    undefined,
    undefined,
  ).toString();
  const binaryHash = createHash("sha256")
    .update(fs.readFileSync(runtimeEsbuild.runtimeEsbuildBinaryPath))
    .digest("hex");

  if (!components.some((component) => component["bom-ref"] === platformPurl)) {
    components.push({
      type: "library",
      group: platformGroup,
      name: platformName,
      version: runtimeEsbuild.platformMetadata.version,
      "bom-ref": platformPurl,
      description: runtimeEsbuild.platformMetadata.description,
      licenses: [{ license: { id: runtimeEsbuild.platformMetadata.license } }],
      purl: platformPurl,
      hashes: [{ alg: "SHA-256", content: binaryHash }],
    });
  }
  sbom.components = components;

  const dependencies = sbom.dependencies ?? [];
  let esbuildDependency = dependencies.find(
    (dependency) => dependency.ref === esbuildComponent["bom-ref"],
  );
  if (!esbuildDependency) {
    esbuildDependency = { ref: esbuildComponent["bom-ref"], dependsOn: [] };
    dependencies.push(esbuildDependency);
  }
  esbuildDependency.dependsOn ??= [];
  if (!esbuildDependency.dependsOn.includes(platformPurl)) {
    esbuildDependency.dependsOn.push(platformPurl);
  }
  if (!dependencies.some((dependency) => dependency.ref === platformPurl)) {
    dependencies.push({ ref: platformPurl });
  }
  sbom.dependencies = dependencies;
}

const seaNode = process.env.ACPX_SEA_NODE ?? process.execPath;
assertSeaCapable(seaNode);
const seaNodeVersion = resolveSeaNodeVersion(seaNode, process.env.ACPX_SEA_NODE_VERSION);
const seaBuildEnv = {
  ...process.env,
  ACPX_SEA_NODE_VERSION: seaNodeVersion,
};

// `pnpm exec`, never `npx`: npx resolves from the registry at run time, so a
// compromised release of a build tool would be fetched unpinned and handed
// write access to the exact bytes users install. pnpm exec resolves from the
// lockfile and fails closed when the tool is absent.
run("pnpm", ["exec", "tsdown", "-c", path.join(here, "tsdown.sea.config.ts")], seaBuildEnv);
run("pnpm", ["exec", "tsdown", "-c", path.join(here, "tsdown.runtime.config.ts")], seaBuildEnv);
run(
  "pnpm",
  ["exec", "tsdown", "-c", path.join(here, "tsdown.flow-runtime.config.ts")],
  seaBuildEnv,
);
const runtimeEsbuild = materializeFlowRuntimeEsbuild();

fs.writeFileSync(bundlePath, CJS_WRAPPER_SHIM + fs.readFileSync(bundlePath, "utf8"));

/**
 * The SBOM is emitted by rollup-plugin-sbom during the bundle above, from the
 * bundler's own module graph. Assert it landed: a plugin that silently stopped
 * running would leave the release attesting an SBOM from a previous build, or
 * publishing none at all while the job stayed green.
 */
if (!fs.existsSync(sbomPath)) {
  throw new Error(`${sbomPath} was not emitted; rollup-plugin-sbom did not run.`);
}
const sbom = JSON.parse(fs.readFileSync(sbomPath, "utf8"));
addFlowRuntimeEsbuildToSbom(sbom, runtimeEsbuild);
fs.writeFileSync(sbomPath, `${JSON.stringify(sbom, null, 2)}\n`);
const sbomComponents = sbom.components ?? [];
if (sbomComponents.length === 0) {
  throw new Error(`${sbomPath} lists no components; the SBOM describes nothing.`);
}

run(seaNode, ["--experimental-sea-config", path.join(here, "sea-config.json")]);

// Inject the blob into a copy of the host Node binary.
fs.copyFileSync(seaNode, binaryPath);
fs.chmodSync(binaryPath, 0o755);

if (process.platform === "darwin") {
  run("codesign", ["--remove-signature", binaryPath]);
}

run("pnpm", [
  "exec",
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

/**
 * Prove the blob is actually in there.
 *
 * A failed or skipped injection leaves behind a plain copy of the Node binary,
 * which still starts, still exits 0, and answers `--version` with Node's own
 * version. That artifact is indistinguishable from success unless the output is
 * checked, and it has shipped once already.
 */
const expectedVersion = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
).version;
const reported = execFileSync(binaryPath, ["--version"], { encoding: "utf8" }).trim();

if (reported !== expectedVersion) {
  throw new Error(
    `Injection verification failed: ${binaryPath} reported "${reported}", expected "${expectedVersion}".\n` +
      "A bare Node copy reports Node's version — the SEA blob was not injected.",
  );
}

process.stdout.write(
  `\nBuilt ${binaryPath} (verified acpx ${reported}, SBOM lists ${sbomComponents.length} components)\n`,
);
