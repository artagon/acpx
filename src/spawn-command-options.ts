import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function readWindowsEnvValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  // Node sorts Windows environment keys lexicographically before selecting the
  // first case-insensitive match. Mirror that rule so command resolution and
  // the eventual spawn observe the same value when differently cased keys
  // coexist.
  const normalizedKey = key.toUpperCase();
  const matchedKey = Object.keys(env)
    .toSorted()
    .find((entry) => entry.toUpperCase() === normalizedKey);
  return matchedKey ? env[matchedKey] : undefined;
}

const WINDOWS_DIRECT_EXTENSIONS = new Set([".com", ".exe", ".bat", ".cmd"]);
const WINDOWS_NATIVE_WRAPPER_EXTENSIONS = new Set([".com", ".exe", ".bat", ".cmd", ".ps1"]);

function windowsExecutableExtensions(
  env: NodeJS.ProcessEnv,
  supportedExtensions: ReadonlySet<string>,
): string[] {
  return (readWindowsEnvValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => supportedExtensions.has(value));
}

function commandCandidates(
  command: string,
  env: NodeJS.ProcessEnv,
  supportedExtensions: ReadonlySet<string>,
): string[] {
  const commandExtension = path.extname(command);
  if (commandExtension.length > 0) {
    return [command];
  }
  return windowsExecutableExtensions(env, supportedExtensions).map(
    (extension) => `${command}${extension}`,
  );
}

function commandHasPath(command: string): boolean {
  return command.includes("/") || command.includes("\\") || path.isAbsolute(command);
}

function windowsEnvHasKey(env: NodeJS.ProcessEnv, key: string): boolean {
  return readWindowsEnvValue(env, key) !== undefined;
}

function isWindowsPathQuote(character: string | undefined): character is '"' | "'" {
  return character === '"' || character === "'";
}

function normalizeWindowsPathEntry(entry: string, cwd: string): string | undefined {
  const start = isWindowsPathQuote(entry[0]) ? 1 : 0;
  const end = isWindowsPathQuote(entry.at(-1)) ? -1 : entry.length;
  const unquoted = entry.slice(start, end);
  if (!unquoted) {
    return undefined;
  }
  // Always resolve against the child cwd. On Windows, a root-relative entry
  // such as `\tools` is absolute but still inherits the cwd drive.
  return path.resolve(cwd, unquoted);
}

function splitWindowsPath(value: string): string[] {
  const entries: string[] = [];
  let entryStart = 0;
  while (entryStart <= value.length) {
    let separatorSearchStart = entryStart;
    const quote = value[entryStart];
    if (isWindowsPathQuote(quote)) {
      const closingQuote = value.indexOf(quote, entryStart + 1);
      separatorSearchStart = closingQuote === -1 ? value.length : closingQuote;
    }
    const separator = value.indexOf(";", separatorSearchStart);
    if (separator === -1) {
      entries.push(value.slice(entryStart));
      break;
    }
    entries.push(value.slice(entryStart, separator));
    entryStart = separator + 1;
  }
  return entries;
}

function windowsSearchDirectories(
  env: NodeJS.ProcessEnv,
  cwd: string,
  includeDefaultCurrentDirectory: boolean,
): string[] {
  const configured = splitWindowsPath(readWindowsEnvValue(env, "PATH") ?? "")
    .map((entry) => normalizeWindowsPathEntry(entry, cwd))
    .filter((entry): entry is string => entry !== undefined);
  const searchesCurrentDirectory =
    includeDefaultCurrentDirectory && !windowsEnvHasKey(env, "NODEFAULTCURRENTDIRECTORYINEXEPATH");
  return searchesCurrentDirectory ? [cwd, ...configured] : configured;
}

function windowsCommandPaths(
  command: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  includeDefaultCurrentDirectory: boolean,
  supportedExtensions: ReadonlySet<string>,
): string[] {
  const candidates = commandCandidates(command, env, supportedExtensions);
  if (commandHasPath(command)) {
    return candidates.map((candidate) => path.resolve(cwd, candidate));
  }

  const paths: string[] = [];
  for (const directory of windowsSearchDirectories(env, cwd, includeDefaultCurrentDirectory)) {
    paths.push(...candidates.map((candidate) => path.join(directory, candidate)));
  }
  return paths;
}

function isExistingFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function resolveWindowsWrapperToken(token: string, wrapperPath: string): string | undefined {
  const relative = token.match(/%~?dp0%?\s*[\\/]*(.*)$/i)?.[1]?.trim();
  if (!relative) {
    return undefined;
  }
  const candidate = path.resolve(
    path.dirname(wrapperPath),
    relative.replace(/[\\/]+/g, path.sep).replace(/^[\\/]+/, ""),
  );
  return path.extname(candidate).toLowerCase() === ".exe" && fs.existsSync(candidate)
    ? candidate
    : undefined;
}

function resolveWindowsWrapperExecutable(wrapperPath: string): string | undefined {
  if (!fs.existsSync(wrapperPath)) {
    return undefined;
  }

  try {
    const content = fs.readFileSync(wrapperPath, "utf8");
    return [...content.matchAll(/"([^"\r\n]*)"/g)]
      .map((match) => resolveWindowsWrapperToken(match[1] ?? "", wrapperPath))
      .find((candidate): candidate is string => candidate !== undefined);
  } catch {
    // Ignore unreadable wrapper scripts and let callers use their fallback.
    return undefined;
  }
}

export function resolveWindowsCommand(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  includeDefaultCurrentDirectory = true,
): string | undefined {
  return windowsCommandPaths(
    command,
    env,
    cwd,
    includeDefaultCurrentDirectory,
    WINDOWS_DIRECT_EXTENSIONS,
  ).find((candidate) => isExistingFile(candidate));
}

/**
 * Resolve a Windows command to a native executable suitable for direct spawn.
 *
 * Batch and PowerShell shims are intentionally rejected unless they point at a
 * real `.exe` entrypoint. Callers that need shell execution should use the
 * command-specific shell policy instead.
 */
export function resolveWindowsExecutablePath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string | undefined {
  for (const candidate of windowsCommandPaths(
    command,
    env,
    cwd,
    false,
    WINDOWS_NATIVE_WRAPPER_EXTENSIONS,
  )) {
    if (!isExistingFile(candidate)) {
      continue;
    }
    return resolveNativeWindowsExecutable(candidate);
  }
  return undefined;
}

function resolveNativeWindowsExecutable(resolved: string): string | undefined {
  const absolute = path.resolve(resolved);
  const extension = path.extname(absolute).toLowerCase();
  if (extension === ".com" || extension === ".exe") {
    return absolute;
  }
  if (extension !== ".cmd" && extension !== ".bat" && extension !== ".ps1") {
    return undefined;
  }

  const siblingExecutable = `${absolute.slice(0, -extension.length)}.exe`;
  return fs.existsSync(siblingExecutable)
    ? siblingExecutable
    : resolveWindowsWrapperExecutable(absolute);
}

function shouldUseWindowsBatchShell(
  command: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): boolean {
  if (platform !== "win32") {
    return false;
  }
  const resolvedCommand = resolveWindowsCommand(command, env, cwd) ?? command;
  const ext = path.extname(resolvedCommand).toLowerCase();
  return ext === ".cmd" || ext === ".bat";
}

export type AgentSpawnCommand = {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
};

const CMD_META_CHAR_RE = /([()\][%!^"`<>&|;, *?])/gu;
const CMD_BACKSLASH_QUOTE_RE = /(?=(\\+?)?)\1"/gu;
const CMD_TRAILING_BACKSLASH_RE = /(?=(\\+?)?)\1$/gu;
const CMD_SHIM_RE = /node_modules[\\/].bin[\\/][^\\/]+\.cmd$/iu;

function escapeCmdCommand(value: string): string {
  return value.replace(CMD_META_CHAR_RE, "^$1");
}

function escapeCmdArgument(value: string, doubleEscapeMeta: boolean): string {
  const quoted = `"${value
    .replace(CMD_BACKSLASH_QUOTE_RE, '$1$1\\"')
    .replace(CMD_TRAILING_BACKSLASH_RE, "$1$1")}"`;
  const escaped = quoted.replace(CMD_META_CHAR_RE, "^$1");
  return doubleEscapeMeta ? escaped.replace(CMD_META_CHAR_RE, "^$1") : escaped;
}

export function buildAgentSpawnCommand(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): AgentSpawnCommand {
  if (platform !== "win32") {
    return { command, args: [...args] };
  }
  return buildWindowsAgentSpawnCommand(command, args, env, cwd);
}

function buildWindowsAgentSpawnCommand(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): AgentSpawnCommand {
  const resolved = resolveWindowsCommand(command, env, cwd, false);
  const resolvedCommand = path.win32.normalize(resolved ?? command);
  const extension = path.extname(resolvedCommand).toLowerCase();
  if (extension !== ".cmd" && extension !== ".bat") {
    return { command: resolved ?? command, args: [...args] };
  }
  const doubleEscapeMeta = CMD_SHIM_RE.test(resolvedCommand);
  const shellCommand = [
    escapeCmdCommand(resolvedCommand),
    ...args.map((arg) => escapeCmdArgument(arg, doubleEscapeMeta)),
  ].join(" ");
  return {
    command: readWindowsEnvValue(env, "COMSPEC") ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${shellCommand}"`],
    windowsVerbatimArguments: true,
  };
}

export function buildSpawnCommandOptions(
  command: string,
  options: Parameters<typeof spawn>[2],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Parameters<typeof spawn>[2] {
  const cwd = typeof options.cwd === "string" ? options.cwd : process.cwd();
  if (!shouldUseWindowsBatchShell(command, platform, env, cwd)) {
    return options;
  }
  return {
    ...options,
    shell: true,
  };
}

export type TerminalSpawnCommand = {
  command: string;
  args: string[];
  killProcessGroup: boolean;
};

export function buildTerminalSpawnCommand(
  command: string,
  args: string[] | undefined,
): TerminalSpawnCommand {
  return { command, args: args ?? [], killProcessGroup: true };
}

export function buildTerminalShellSpawnCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
): TerminalSpawnCommand {
  if (platform === "win32") {
    return { command: "cmd.exe", args: ["/d", "/s", "/c", command], killProcessGroup: true };
  }
  return { command: "/bin/sh", args: ["-c", command], killProcessGroup: true };
}
