import { Bench, type Task } from "tinybench";

export type BenchmarkEngineTask = Readonly<{
  name: string;
  execute: () => Promise<number>;
}>;

export type BenchmarkEngineResult = Readonly<{
  name: string;
  durationMs: number;
}>;

type RegisteredTask = Readonly<{
  input: BenchmarkEngineTask;
  tinybenchTask: Task;
}>;

export async function runBenchmarkPair(
  tasks: readonly [BenchmarkEngineTask, BenchmarkEngineTask],
): Promise<readonly [BenchmarkEngineResult, BenchmarkEngineResult]> {
  const bench = new Bench({
    concurrency: null,
    time: 0,
    iterations: 1,
    warmup: false,
    retainSamples: true,
    throws: true,
  });
  const registered = tasks.map((task) => registerTask(bench, task));

  await bench.run();

  return [toEngineResult(registered[0]), toEngineResult(registered[1])];
}

function registerTask(bench: Bench, input: BenchmarkEngineTask): RegisteredTask {
  bench.add(
    input.name,
    async () => {
      const durationMs = await input.execute();
      validateDuration(durationMs, input.name);
      return { overriddenDuration: durationMs };
    },
    { async: true },
  );
  const tinybenchTask = bench.getTask(input.name);
  if (tinybenchTask === undefined) {
    throw new Error(`Tinybench did not retain task: ${input.name}`);
  }
  return { input, tinybenchTask };
}

function toEngineResult(registered: RegisteredTask): BenchmarkEngineResult {
  const result = registered.tinybenchTask.result;
  if (result.state !== "completed") {
    throw new Error(
      `Tinybench task ${registered.input.name} did not complete; state was ${result.state}.`,
    );
  }
  const samples = result.latency.samples;
  if (samples === undefined || samples.length !== 1) {
    throw new Error(`Tinybench task ${registered.input.name} did not retain exactly one sample.`);
  }
  const durationMs = samples[0];
  validateDuration(durationMs, registered.input.name);
  return { name: registered.input.name, durationMs };
}

function validateDuration(durationMs: number, taskName: string): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new Error(`Benchmark task ${taskName} must return a finite nonnegative duration.`);
  }
}
