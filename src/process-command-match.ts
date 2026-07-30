import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { splitCommandLine } from "./acp/client-process.js";

const execFileAsync = promisify(execFile);

export function firstAgentCommandToken(command: string): string | undefined {
  try {
    const parsed = splitCommandLine(command);
    return parsed.command || undefined;
  } catch {
    return undefined;
  }
}

export async function isLikelyMatchingProcess(pid: number, agentCommand: string): Promise<boolean> {
  const expectedToken = firstAgentCommandToken(agentCommand);
  if (!expectedToken) {
    return false;
  }

  const argv = await readProcessArgv(pid);
  if (argv.length === 0) {
    return false;
  }

  const executableBase = path.basename(argv[0]);
  const expectedBase = path.basename(expectedToken);
  return (
    executableBase === expectedBase || argv.some((entry) => path.basename(entry) === expectedBase)
  );
}

async function readProcessArgv(pid: number): Promise<string[]> {
  const procArgv = await readProcCmdline(pid);
  if (procArgv) {
    return procArgv;
  }

  const commandLine =
    process.platform === "win32"
      ? await readWindowsCommandLine(pid)
      : await readPosixCommandLine(pid);
  return splitCommandLineLike(commandLine);
}

async function readProcCmdline(pid: number): Promise<string[] | undefined> {
  try {
    const payload = await fs.readFile(`/proc/${pid}/cmdline`, "utf8");
    return payload
      .split("\u0000")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  } catch {
    return undefined;
  }
}

async function readPosixCommandLine(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "command="]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function readWindowsCommandLine(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
      ],
      { windowsHide: true },
    );
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function splitCommandLineLike(commandLine: string | undefined): string[] {
  if (!commandLine) {
    return [];
  }
  try {
    const parsed = splitCommandLine(commandLine);
    return [parsed.command, ...parsed.args];
  } catch {
    return commandLine
      .split(/\s+/u)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
}
