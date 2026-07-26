import path from "node:path";
import { defineConfig } from "tsdown";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

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
});
