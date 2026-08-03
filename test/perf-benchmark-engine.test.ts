import assert from "node:assert/strict";
import test from "node:test";
import { runBenchmarkPair, type BenchmarkEngineTask } from "../scripts/perf/benchmark-engine.js";

function fixedTask(name: string, durationMs: number, executionLog: string[]): BenchmarkEngineTask {
  return {
    name,
    execute: async () => {
      executionLog.push(name);
      return durationMs;
    },
  };
}

test("runs each task once in registration order and returns exact external durations", async () => {
  const executionLog: string[] = [];

  const result = await runBenchmarkPair([
    fixedTask("baseline", 12.5, executionLog),
    fixedTask("candidate", 8.25, executionLog),
  ]);

  assert.deepEqual(executionLog, ["baseline", "candidate"]);
  assert.deepEqual(result, [
    { name: "baseline", durationMs: 12.5 },
    { name: "candidate", durationMs: 8.25 },
  ]);
});

test("creates a fresh benchmark with isolated tasks and results for every pair", async () => {
  const firstLog: string[] = [];
  const secondLog: string[] = [];

  const first = await runBenchmarkPair([
    fixedTask("first-a", 1, firstLog),
    fixedTask("first-b", 2, firstLog),
  ]);
  const second = await runBenchmarkPair([
    fixedTask("second-a", 3, secondLog),
    fixedTask("second-b", 4, secondLog),
  ]);

  assert.deepEqual(firstLog, ["first-a", "first-b"]);
  assert.deepEqual(secondLog, ["second-a", "second-b"]);
  assert.deepEqual(first, [
    { name: "first-a", durationMs: 1 },
    { name: "first-b", durationMs: 2 },
  ]);
  assert.deepEqual(second, [
    { name: "second-a", durationMs: 3 },
    { name: "second-b", durationMs: 4 },
  ]);
});

test("accepts zero and rejects every non-finite or negative external duration", async () => {
  const executionLog: string[] = [];
  const zero = await runBenchmarkPair([
    fixedTask("zero", 0, executionLog),
    fixedTask("positive", 1, executionLog),
  ]);

  assert.equal(zero[0].durationMs, 0);
  for (const invalidDuration of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    -1,
  ]) {
    await assert.rejects(
      runBenchmarkPair([fixedTask("valid", 1, []), fixedTask("invalid", invalidDuration, [])]),
      /finite nonnegative duration/u,
    );
  }
});

test("propagates the original task failure", async () => {
  const sentinel = new Error("sentinel benchmark failure");

  await assert.rejects(
    runBenchmarkPair([
      fixedTask("valid", 1, []),
      {
        name: "failure",
        execute: async () => {
          throw sentinel;
        },
      },
    ]),
    (error: unknown) => error === sentinel,
  );
});
