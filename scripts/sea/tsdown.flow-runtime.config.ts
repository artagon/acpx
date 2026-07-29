import path from "node:path";
import { defineConfig } from "tsdown";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

export default defineConfig({
  entry: [path.join(repoRoot, "src/flows.ts")],
  format: "esm",
  platform: "node",
  target: "node22",
  outDir: path.join(repoRoot, "dist-sea", "runtime"),
  dts: false,
  clean: false,
  fixedExtension: false,
  sourcemap: false,
  deps: { alwaysBundle: [/.*/] },
  outputOptions: { codeSplitting: false },
});
