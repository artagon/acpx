import path from "node:path";
import { Enums, Models } from "@cyclonedx/cyclonedx-library";
import { PackageURL } from "packageurl-js";
import sbom from "rollup-plugin-sbom";
import { defineConfig } from "tsdown";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

/**
 * Target triple for the SBOM's metadata. The release workflow sets it per
 * matrix leg; a local build labels itself with the host it ran on.
 */
const target = process.env.ACPX_SEA_TARGET ?? `${process.platform}-${process.arch}`;

const nodeVersion = (process.env.ACPX_SEA_NODE_VERSION ?? process.versions.node).replace(/^v/, "");

/**
 * The Node.js runtime, as a first-class component.
 *
 * The binary is a copy of the host Node with a blob injected, so the runtime —
 * and with it V8, OpenSSL, zlib, and ICU — is the majority of the file and its
 * largest attack surface. The bundler's module graph only sees JavaScript, so
 * without this the SBOM would describe a minority of the bytes and no scanner
 * would ever match a Node advisory against the artifact.
 */
function nodeRuntimeComponent(): Models.Component {
  const [os, arch] = target.split("-");
  const component = new Models.Component(Enums.ComponentType.Application, "node", {
    version: nodeVersion,
    description: `Official Node.js ${nodeVersion} build for ${target}; the executable is a copy of it with a SEA blob injected.`,
    purl: new PackageURL("generic", undefined, "node", nodeVersion, { os, arch }, undefined),
  });
  // SpdxLicense, not NamedLicense: only the former emits `license.id`, which is
  // what license scanners match on.
  component.licenses.add(new Models.SpdxLicense("MIT"));
  component.externalReferences.add(
    new Models.ExternalReference(
      `https://nodejs.org/dist/v${nodeVersion}/`,
      Enums.ExternalReferenceType.Distribution,
    ),
  );
  return component;
}

/**
 * Single-executable build: one CommonJS chunk with every dependency inlined.
 *
 * A V8 startup snapshot resolves nothing from disk at runtime, so code
 * splitting must be off and no dependency may stay external. CommonJS is
 * required because Node rejects `mainFormat: "module"` together with
 * `useSnapshot`.
 *
 * Note this build cannot benefit from the lazy-import graph the normal build
 * relies on — everything here is eager by construction. It exists for
 * dependency-free distribution, not for speed.
 */
export default defineConfig({
  entry: [path.join(repoRoot, "src/sea/entry.ts")],
  format: "cjs",
  platform: "node",
  target: "node22",
  outDir: path.join(repoRoot, "dist-sea"),
  dts: false,
  clean: true,
  fixedExtension: false,
  sourcemap: false,
  deps: { alwaysBundle: [/.*/] },
  outputOptions: { codeSplitting: false },
  plugins: [
    /**
     * SBOM of the artifact, not of the checkout.
     *
     * The two obvious inputs both describe something else. Scanning the source
     * tree with syft reports 751 components — every devDependency, none of
     * which reaches a user. Scanning the finished binary reports zero: the
     * JavaScript is one bundled chunk inside a V8 snapshot, so per-package
     * boundaries no longer exist in the file. The production dependency
     * closure sits in between at 271, still an order of magnitude off, because
     * tree-shaking drops most of it.
     *
     * This plugin reads the bundler's own module graph, so it lists exactly
     * the packages whose code was inlined — 18 here. It runs inside the build
     * that produces the binary rather than inferring the contents afterwards.
     */
    sbom({
      outDir: ".",
      outFilename: "sbom",
      outFormats: ["json"],
      // Pinned rather than left at the plugin's default of 1.7: 1.6 is what
      // the attestation tooling and downstream scanners consume today, and an
      // SBOM no one can parse is worse than none.
      specVersion: "1.6",
      // Reproducibility: every other field is a function of the commit and the
      // build, so a wall clock would make each rebuild differ for no gain and
      // remove the ability to diff a local rebuild against the published SBOM.
      saveTimestamp: false,
      generateSerial: false,
      includeWellKnown: false,
      collectLicenseEvidence: true,
      properties: [
        { name: "acpx:target", value: target },
        { name: "acpx:node-version", value: nodeVersion },
        ...(process.env.GITHUB_SHA ? [{ name: "acpx:commit", value: process.env.GITHUB_SHA }] : []),
      ],
      beforeCollect: (bom) => {
        bom.components.add(nodeRuntimeComponent());
      },
    }),
  ],
});
