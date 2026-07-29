import path from "node:path";
import { defineConfig } from "tsdown";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

/**
 * A normal Node runtime for commands that must load user modules dynamically.
 *
 * V8 startup snapshots cannot provide the dynamic-import callback needed by
 * `flow run`. The SEA extracts the delegated CLI, flow module, and private
 * esbuild runtime, then runs the CLI with the formula's Node dependency only
 * for flow commands. Other dependencies stay bundled so the extracted runtime
 * never resolves packages outside its private temp directory.
 */
export default defineConfig({
  entry: [path.join(repoRoot, "src/sea/delegated-entry.ts")],
  format: "cjs",
  platform: "node",
  target: "node22",
  outDir: path.join(repoRoot, "dist-sea", "runtime"),
  dts: false,
  clean: true,
  fixedExtension: false,
  sourcemap: false,
  deps: {
    alwaysBundle: [/.*/],
    neverBundle: ["esbuild"],
  },
  outputOptions: { codeSplitting: false },
});
