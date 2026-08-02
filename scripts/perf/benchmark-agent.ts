#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Agent,
  type AgentSideConnection as AgentConnection,
  type InitializeResponse,
  type ListSessionsResponse,
  type NewSessionResponse,
  type PromptResponse,
  type SetSessionConfigOptionResponse,
  type SetSessionModeResponse,
} from "@agentclientprotocol/sdk";

export type BenchmarkTraceEventName =
  | "agent.process_start"
  | "agent.initialize.start"
  | "agent.initialize.end"
  | "agent.session_list.start"
  | "agent.session_list.end"
  | "agent.new_session.start"
  | "agent.new_session.end"
  | "agent.prompt.start"
  | "agent.prompt.end"
  | "agent.stdin_end"
  | "agent.sigterm"
  | "agent.exit";

export type BenchmarkTraceEvent = Readonly<{
  event: BenchmarkTraceEventName;
  pid: number;
  timestampMs: number;
}>;

const BENCHMARK_RESPONSE_TEXT = "benchmark agent response";

function timestampMs(): number {
  return performance.timeOrigin + performance.now();
}

function toByteStream(input: Readable): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      input.on("data", (chunk: unknown) => {
        if (!(chunk instanceof Uint8Array)) {
          controller.error(new Error("Expected stdin to provide byte chunks."));
          return;
        }
        controller.enqueue(chunk);
      });
      input.once("end", () => {
        controller.close();
      });
      input.once("error", (error: unknown) => {
        controller.error(error);
      });
    },
    cancel() {
      input.destroy();
    },
  });
}

export function appendBenchmarkTrace(
  traceFile: string | undefined,
  event: BenchmarkTraceEventName,
): void {
  if (!traceFile) {
    return;
  }

  const traceEvent: BenchmarkTraceEvent = {
    event,
    pid: process.pid,
    timestampMs: timestampMs(),
  };
  appendFileSync(traceFile, `${JSON.stringify(traceEvent)}\n`, "utf8");
}

function traceSynchronousOperation<Result>(
  traceFile: string | undefined,
  startEvent: BenchmarkTraceEventName,
  endEvent: BenchmarkTraceEventName,
  operation: () => Result,
): Result {
  appendBenchmarkTrace(traceFile, startEvent);
  try {
    return operation();
  } finally {
    appendBenchmarkTrace(traceFile, endEvent);
  }
}

export function createBenchmarkAgent(connection: AgentConnection, traceFile: string | undefined): Agent {
  const initialize = (): InitializeResponse =>
    traceSynchronousOperation(
      traceFile,
      "agent.initialize.start",
      "agent.initialize.end",
      () => ({
        protocolVersion: PROTOCOL_VERSION,
        authMethods: [],
        agentCapabilities: {
          sessionCapabilities: {
            list: {},
          },
        },
      }),
    );
  const newSession = (): NewSessionResponse =>
    traceSynchronousOperation(
      traceFile,
      "agent.new_session.start",
      "agent.new_session.end",
      () => ({ sessionId: randomUUID() }),
    );
  const listSessions = (): ListSessionsResponse =>
    traceSynchronousOperation(
      traceFile,
      "agent.session_list.start",
      "agent.session_list.end",
      () => ({ sessions: [] }),
    );
  const prompt = async (sessionId: string): Promise<PromptResponse> => {
    appendBenchmarkTrace(traceFile, "agent.prompt.start");
    try {
      await connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: BENCHMARK_RESPONSE_TEXT,
          },
        },
      });
      return { stopReason: "end_turn" };
    } finally {
      appendBenchmarkTrace(traceFile, "agent.prompt.end");
    }
  };
  const setSessionMode = (): SetSessionModeResponse => ({});
  const setSessionConfigOption = (): SetSessionConfigOptionResponse => ({ configOptions: [] });

  return {
    initialize,
    authenticate: () => undefined,
    newSession,
    listSessions,
    prompt: async (params) => await prompt(params.sessionId),
    cancel: () => undefined,
    setSessionMode,
    setSessionConfigOption,
  };
}

export function parseBenchmarkAgentArgs(
  argv: readonly string[],
): Readonly<{ traceFile?: string }> {
  if (argv.length === 0) {
    return {};
  }
  if (argv[0] !== "--trace-file") {
    throw new Error(`Unknown argument: ${argv[0]}`);
  }
  if (
    typeof argv[1] !== "string" ||
    argv[1].trim().length === 0 ||
    argv[1].startsWith("--")
  ) {
    throw new Error("--trace-file requires a path.");
  }
  if (argv.length > 2) {
    throw new Error(`Unknown argument: ${argv[2]}`);
  }

  return { traceFile: argv[1] };
}

export async function runBenchmarkAgent(argv: readonly string[]): Promise<void> {
  const { traceFile } = parseBenchmarkAgentArgs(argv);
  appendBenchmarkTrace(traceFile, "agent.process_start");
  process.stdin.once("end", () => {
    appendBenchmarkTrace(traceFile, "agent.stdin_end");
  });
  process.once("SIGTERM", () => {
    appendBenchmarkTrace(traceFile, "agent.sigterm");
    process.exit(0);
  });
  process.once("exit", () => {
    appendBenchmarkTrace(traceFile, "agent.exit");
  });

  const output = Writable.toWeb(process.stdout);
  const input = toByteStream(process.stdin);
  const stream = ndJsonStream(output, input);
  const connection = new AgentSideConnection(
    (agentConnection) => createBenchmarkAgent(agentConnection, traceFile),
    stream,
  );
  void connection;
}

function isInvokedEntrypoint(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href;
}

if (isInvokedEntrypoint()) {
  void runBenchmarkAgent(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
