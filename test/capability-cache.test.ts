import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fingerprintExecutable, resolveExecutablePath } from "../src/acp/capability-cache.js";

async function writeExecutable(filePath: string): Promise<void> {
  await fs.writeFile(filePath, "test\n", { mode: 0o755 });
}

test("POSIX capability resolution applies the launch cwd to relative commands and PATH", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-capability-cache-"));
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "cwd");
  const bin = path.join(cwd, "bin");
  await fs.mkdir(bin, { recursive: true });
  await writeExecutable(path.join(cwd, "copilot"));
  await writeExecutable(path.join(bin, "copilot"));

  assert.equal(
    await resolveExecutablePath("./copilot", {
      platform: "linux",
      cwd,
      env: { PATH: "" },
    }),
    path.join(cwd, "copilot"),
  );
  assert.equal(
    await resolveExecutablePath("copilot", {
      platform: "linux",
      cwd,
      env: { PATH: "bin" },
    }),
    path.join(bin, "copilot"),
  );
});

test("Windows capability resolution does not let the working directory shadow PATH", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-capability-cache-"));
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "cwd");
  const bin = path.join(root, "bin");
  await fs.mkdir(cwd);
  await fs.mkdir(bin);
  await writeExecutable(path.join(cwd, "copilot"));
  await writeExecutable(path.join(cwd, "copilot.cmd"));
  await writeExecutable(path.join(bin, "copilot.exe"));

  assert.equal(
    await resolveExecutablePath("copilot", {
      platform: "win32",
      cwd,
      env: { Path: bin, Pathext: ".EXE;.CMD" },
    }),
    path.join(bin, "copilot.exe"),
  );
});

test("Windows capability resolution normalizes quoted relative PATH entries", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-capability-cache-"));
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "cwd");
  const relativeBin = path.join(cwd, "tools");
  await fs.mkdir(cwd);
  await fs.mkdir(relativeBin);
  await writeExecutable(path.join(relativeBin, "copilot.cmd"));

  assert.equal(
    await resolveExecutablePath("copilot", {
      platform: "win32",
      cwd,
      env: {
        Path: '"tools"',
        Pathext: ".CMD",
        NoDefaultCurrentDirectoryInExePath: "1",
      },
    }),
    path.join(relativeBin, "copilot.cmd"),
  );
});

test("Windows launcher shims bypass the executable capability cache", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-capability-cache-"));
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  await writeExecutable(path.join(root, "copilot.cmd"));

  assert.equal(
    await fingerprintExecutable("copilot", {
      platform: "win32",
      cwd: root,
      env: { PATH: root, PATHEXT: ".CMD" },
    }),
    undefined,
  );
});

test("Windows native launchers bypass the executable capability cache", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-capability-cache-"));
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  await writeExecutable(path.join(root, "copilot.exe"));

  assert.equal(
    await fingerprintExecutable("copilot", {
      platform: "win32",
      cwd: root,
      env: { PATH: root, PATHEXT: ".EXE" },
    }),
    undefined,
  );
});

test("capability resolution skips directories that look executable", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-capability-cache-"));
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  await fs.mkdir(first);
  await fs.mkdir(second);
  await fs.mkdir(path.join(first, "copilot.exe"));
  await writeExecutable(path.join(second, "copilot.exe"));

  assert.equal(
    await resolveExecutablePath("copilot", {
      platform: "win32",
      cwd: root,
      env: { PATH: `${first};${second}`, PATHEXT: ".EXE" },
    }),
    path.join(second, "copilot.exe"),
  );
});
