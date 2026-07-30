import fs from "node:fs/promises";
import { delegateSeaFlowCommand } from "../../src/sea/flow-delegation.js";

const mode = process.argv[2];
const originalRm = fs.rm;

function toArrayBuffer(source: string): ArrayBuffer {
  const bytes = Buffer.from(source);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

fs.rm = async (target, options) => {
  await originalRm(target, options);
  throw new Error("injected cleanup failure");
};

const getAsset = (key: string): ArrayBuffer => {
  if (mode === "operation-error") {
    throw new Error("injected operation failure");
  }
  if (key === "acpx-flow-cli" && mode === "stubborn-descendant") {
    return toArrayBuffer(
      [
        'const { spawn } = require("node:child_process");',
        "const descendant = spawn(",
        "  process.execPath,",
        '  ["-e", "process.on(\\"SIGTERM\\", () => {}); process.stdout.write(\\"READY\\\\n\\"); setInterval(() => {}, 1_000);"],',
        '  { stdio: ["ignore", "pipe", "ignore"] },',
        ");",
        'descendant.stdout.once("data", () => {',
        "  process.stdout.write(`READY ${process.pid} ${descendant.pid}\\n`);",
        '  process.on("SIGTERM", () => process.exit(0));',
        "});",
        "setInterval(() => {}, 1_000);",
        "",
      ].join("\n"),
    );
  }
  if (key === "acpx-flow-cli" && mode === "signal") {
    return toArrayBuffer(
      "process.stdout.write(`READY ${process.pid}\\n`);\nsetInterval(() => {}, 1_000);\n",
    );
  }
  return new ArrayBuffer(0);
};

try {
  await delegateSeaFlowCommand(["node", "acpx", "flow"], getAsset);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  fs.rm = originalRm;
}
