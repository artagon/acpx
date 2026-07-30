#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_MINIMUM_AGE_MINUTES = 2880;
const REGISTRY_ORIGIN = "https://registry.npmjs.org";
const FETCH_CONCURRENCY = 12;
const FETCH_ATTEMPTS = 3;
const FETCH_TIMEOUT_MS = 20_000;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const options = {
    lockfile: "pnpm-lock.yaml",
    workspace: "pnpm-workspace.yaml",
    minimumAgeMinutes: DEFAULT_MINIMUM_AGE_MINUTES,
    metadata: undefined,
    now: undefined,
  };
  const names = new Set();

  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--")) {
      fail(`Expected --option value pairs; received ${argv.slice(index).join(" ") || "<none>"}`);
    }
    if (names.has(name)) {
      fail(`Duplicate option ${name}`);
    }
    names.add(name);

    switch (name) {
      case "--lockfile":
        options.lockfile = value;
        break;
      case "--workspace":
        options.workspace = value;
        break;
      case "--minimum-age-minutes":
        options.minimumAgeMinutes = Number(value);
        break;
      case "--metadata":
        options.metadata = value;
        break;
      case "--now":
        options.now = value;
        break;
      default:
        fail(`Unknown option ${name}`);
    }
  }

  if (
    !Number.isSafeInteger(options.minimumAgeMinutes) ||
    options.minimumAgeMinutes < DEFAULT_MINIMUM_AGE_MINUTES
  ) {
    fail(
      `--minimum-age-minutes must be an integer of at least ${DEFAULT_MINIMUM_AGE_MINUTES} (48 hours)`,
    );
  }
  return options;
}

function activeYamlLines(source) {
  return source.split(/\r?\n/).filter((line) => !/^\s*#/.test(line) && line.trim() !== "");
}

function validateReleaseAgeConfiguration(workspacePath, requiredMinutes) {
  const workspace = readFileSync(workspacePath, "utf8");
  const lines = activeYamlLines(workspace);
  const exclusion = lines.find((line) =>
    /(?:minimumReleaseAgeExclude|minimum-release-age-exclude)/.test(line),
  );
  if (exclusion) {
    fail("minimumReleaseAgeExclude is not allowed because it bypasses the release-age gate");
  }

  const declarations = lines.filter((line) =>
    /^\s*(?:"minimumReleaseAge"|'minimumReleaseAge'|minimumReleaseAge)\s*:/.test(line),
  );
  if (declarations.length !== 1) {
    fail(
      `${workspacePath} must contain exactly one canonical minimumReleaseAge declaration; found ${declarations.length}`,
    );
  }
  const match = /^minimumReleaseAge:\s*(\d+)\s*$/.exec(declarations[0]);
  if (!match) {
    fail(`${workspacePath} must use the canonical top-level minimumReleaseAge: MINUTES form`);
  }
  const configuredMinutes = Number(match[1]);
  if (!Number.isSafeInteger(configuredMinutes) || configuredMinutes < requiredMinutes) {
    fail(
      `minimumReleaseAge is ${configuredMinutes} minutes; expected at least ${requiredMinutes} minutes`,
    );
  }

  const npmrcPath = path.join(path.dirname(path.resolve(workspacePath)), ".npmrc");
  if (existsSync(npmrcPath)) {
    const npmrc = readFileSync(npmrcPath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#") && !line.startsWith(";"));
    const override = npmrc.find((line) =>
      /^(?:minimum-release-age(?:-exclude)?|minimumReleaseAge(?:Exclude)?)\s*=/.test(line),
    );
    if (override) {
      fail(`${npmrcPath} must not override minimumReleaseAge or configure an exclusion`);
    }
  }

  return configuredMinutes;
}

function parsePackageIdentity(identity) {
  const delimiter = identity.lastIndexOf("@");
  if (delimiter <= 0) {
    fail(`Invalid pnpm registry package identity ${JSON.stringify(identity)}`);
  }

  const name = identity.slice(0, delimiter);
  const version = identity.slice(delimiter + 1);
  if (
    !name ||
    /\s|[#:\\]/.test(name) ||
    (name.startsWith("@") && !name.includes("/")) ||
    !SEMVER.test(version)
  ) {
    fail(`Invalid pnpm registry package identity ${JSON.stringify(identity)}`);
  }
  return { identity, name, version };
}

function parsePnpmRegistryPackages(lockfilePath) {
  const lines = readFileSync(lockfilePath, "utf8").split(/\r?\n/);
  let packagesSections = 0;
  let inPackages = false;
  let sawSnapshots = false;
  let current;
  const dependencies = [];
  const identities = new Set();

  const finishCurrent = () => {
    if (!current) {
      return;
    }
    if (current.resolutionCount !== 1 || !current.hasIntegrity) {
      fail(
        `${lockfilePath}: ${current.identity} must have exactly one inline integrity-bound registry resolution`,
      );
    }
    if (identities.has(current.identity)) {
      fail(`${lockfilePath}: duplicate package identity ${current.identity}`);
    }
    identities.add(current.identity);
    dependencies.push(parsePackageIdentity(current.identity));
    current = undefined;
  };

  for (const line of lines) {
    if (line === "packages:") {
      packagesSections += 1;
      inPackages = true;
      continue;
    }
    if (inPackages && line === "snapshots:") {
      finishCurrent();
      inPackages = false;
      sawSnapshots = true;
      continue;
    }
    if (!inPackages) {
      continue;
    }

    const key = /^ {2}(?:'([^']+)'|"([^"]+)"|(\S[^:]*)):\s*$/.exec(line);
    if (key) {
      finishCurrent();
      current = {
        identity: key[1] ?? key[2] ?? key[3],
        resolutionCount: 0,
        hasIntegrity: false,
      };
      continue;
    }
    if (!current) {
      if (line.trim() !== "") {
        fail(`${lockfilePath}: unexpected content in packages section`);
      }
      continue;
    }
    if (/^ {4}resolution:/.test(line)) {
      current.resolutionCount += 1;
      current.hasIntegrity =
        /^ {4}resolution:\s+\{integrity:\s+(?:sha512|sha384|sha256|sha1)-[^,}\s]+(?:,\s*[^}]*)?\}\s*$/.test(
          line,
        );
    }
  }
  if (inPackages) {
    finishCurrent();
  }

  if (packagesSections !== 1 || !sawSnapshots) {
    fail(`${lockfilePath} must contain exactly one packages section followed by snapshots`);
  }
  if (dependencies.length === 0) {
    fail(`${lockfilePath} contains no registry dependencies`);
  }
  return dependencies;
}

function readFixtureMetadata(metadataPath) {
  const parsed = JSON.parse(readFileSync(metadataPath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail(`${metadataPath} must contain an object keyed by package name`);
  }
  return parsed;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchPackument(name) {
  const encodedName = encodeURIComponent(name);
  const url = `${REGISTRY_ORIGIN}/${encodedName}`;
  let lastError;

  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: "application/json",
          "user-agent": "acpx-release-age-policy/1",
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (response.ok) {
        return await response.json();
      }

      const message = `${url} returned HTTP ${response.status}`;
      if (response.status !== 429 && response.status < 500) {
        throw new Error(message);
      }
      lastError = new Error(message);
    } catch (error) {
      lastError = error;
    }
    if (attempt < FETCH_ATTEMPTS) {
      await delay(250 * 2 ** (attempt - 1));
    }
  }

  throw new Error(
    `Unable to fetch npm publish metadata for ${name}: ${lastError?.message ?? "unknown error"}`,
  );
}

async function fetchMetadata(dependencies) {
  const names = [...new Set(dependencies.map(({ name }) => name))].toSorted((left, right) =>
    left.localeCompare(right),
  );
  const metadata = Object.create(null);

  for (let offset = 0; offset < names.length; offset += FETCH_CONCURRENCY) {
    const batch = names.slice(offset, offset + FETCH_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (name) => [name, await fetchPackument(name)]),
    );
    for (const [name, packument] of results) {
      metadata[name] = packument;
    }
  }
  return metadata;
}

function verifyPublishTimes(dependencies, metadata, now, minimumAgeMinutes) {
  const violations = [];
  for (const dependency of dependencies) {
    const published = metadata[dependency.name]?.time?.[dependency.version];
    const publishedAt = typeof published === "string" ? Date.parse(published) : Number.NaN;
    if (!Number.isFinite(publishedAt)) {
      violations.push(`${dependency.identity} has no valid npm publish time`);
      continue;
    }

    const ageMinutes = Math.floor((now - publishedAt) / 60_000);
    if (ageMinutes < minimumAgeMinutes) {
      violations.push(
        `${dependency.identity} is ${ageMinutes} minutes old, younger than ${minimumAgeMinutes} minutes`,
      );
    }
  }

  if (violations.length > 0) {
    const shown = violations.slice(0, 20).map((violation) => `- ${violation}`);
    if (violations.length > shown.length) {
      shown.push(`- and ${violations.length - shown.length} more violation(s)`);
    }
    fail(`Locked dependency release-age verification failed:\n${shown.join("\n")}`);
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  validateReleaseAgeConfiguration(options.workspace, options.minimumAgeMinutes);
  const dependencies = parsePnpmRegistryPackages(options.lockfile);
  const now = options.now === undefined ? Date.now() : Date.parse(options.now);
  if (!Number.isFinite(now)) {
    fail(`Invalid --now timestamp ${JSON.stringify(options.now)}`);
  }

  const metadata =
    options.metadata === undefined
      ? await fetchMetadata(dependencies)
      : readFixtureMetadata(options.metadata);
  verifyPublishTimes(dependencies, metadata, now, options.minimumAgeMinutes);
  console.log(
    `Verified ${dependencies.length} locked registry dependencies are at least ${options.minimumAgeMinutes} minutes old.`,
  );
}

main().catch((error) => {
  console.error(`release-age: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
