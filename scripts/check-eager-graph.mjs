#!/usr/bin/env node
// Fails if any third-party package other than the allow-list enters the eager
// (statically imported) chunk closure of dist/cli.js.
//
// Startup cost is dominated by what is evaluated before the CLI can answer.
// @agentclientprotocol/sdk plus its transitive zod was 77% of module init until
// it was moved behind dynamic imports. That win is invisible to break: a single
// value import from the src/session/session.ts barrel silently re-welds the SDK
// into startup and nothing fails except the clock. This is a static assertion
// rather than a benchmark because benchmark noise on developer machines is
// larger than the regression it would need to catch.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(repoRoot, "dist");
const entry = path.join(distDir, "cli.js");

const ALLOWED_EAGER_PACKAGES = new Set(["commander"]);

// Matches static `import ... from "spec"` / `export ... from "spec"` only.
// Dynamic `import("spec")` is deliberately not matched: deferring is the point.
const STATIC_IMPORT = /(?:^|\n)\s*(?:import|export)[^;\n]*?from\s*["']([^"']+)["']/g;
const BARE_SIDE_EFFECT_IMPORT = /(?:^|\n)\s*import\s*["']([^"']+)["']/g;

function specifiersIn(source) {
  const found = [];
  for (const re of [STATIC_IMPORT, BARE_SIDE_EFFECT_IMPORT]) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(source)) !== null) {
      found.push(match[1]);
    }
  }
  return found;
}

function packageNameOf(specifier) {
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
}

if (!fs.existsSync(entry)) {
  console.error(
    `check-eager-graph: ${path.relative(repoRoot, entry)} not found — run the build first.`,
  );
  process.exit(2);
}

const visited = new Set();
const offenders = new Map(); // package name -> chunk that imported it
const queue = [entry];

while (queue.length > 0) {
  const file = queue.pop();
  if (visited.has(file)) {
    continue;
  }
  visited.add(file);

  for (const specifier of specifiersIn(fs.readFileSync(file, "utf8"))) {
    if (specifier.startsWith("node:")) {
      continue;
    }

    if (specifier.startsWith(".")) {
      const resolved = path.resolve(path.dirname(file), specifier);
      if (fs.existsSync(resolved)) {
        queue.push(resolved);
      }
      continue;
    }

    const pkg = packageNameOf(specifier);
    if (!ALLOWED_EAGER_PACKAGES.has(pkg) && !offenders.has(pkg)) {
      offenders.set(pkg, path.relative(repoRoot, file));
    }
  }
}

if (offenders.size > 0) {
  console.error("check-eager-graph: third-party packages in the eager startup graph:\n");
  for (const [pkg, chunk] of offenders) {
    console.error(`  ${pkg}  (statically imported by ${chunk})`);
  }
  console.error(
    `\nAllowed: ${[...ALLOWED_EAGER_PACKAGES].join(", ")}.\n` +
      "Move the import to its call site, or import types only. A value import from\n" +
      "src/session/session.ts re-exports the ACP client and pulls in the SDK + zod.\n",
  );
  process.exit(1);
}

console.log(
  `check-eager-graph: ok — ${visited.size} eager chunks, external packages limited to ${[...ALLOWED_EAGER_PACKAGES].join(", ")}.`,
);
