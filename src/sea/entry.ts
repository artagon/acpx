import v8 from "node:v8";
import { main } from "../cli-core.js";
import { installBrokenPipeHandler } from "../cli/broken-pipe.js";

/**
 * Single-executable entry point, built as CommonJS so it can be snapshotted.
 *
 * Everything above `setDeserializeMainFunction` runs once at build time and is
 * frozen into the snapshot; only the callback runs per invocation. Side effects
 * that touch streams, handles, or argv must stay inside the callback — the
 * snapshot builder rejects open handles, and stdio captured at build time would
 * not be the caller's stdio.
 */
v8.startupSnapshot.setDeserializeMainFunction(() => {
  // A SEA keeps node's argv shape: [execPath, invocationPath, ...userArgs].
  // argv[1] is the path the user typed, not the first user argument, so it must
  // not be re-injected — doing so makes cli-core read it as the agent name and
  // shadow every top-level verb.
  const isQueueOwner = process.argv[2] === "__queue-owner";
  installBrokenPipeHandler(process.stdout, "exit");
  installBrokenPipeHandler(process.stderr, isQueueOwner ? "ignore" : "exit");

  void main(process.argv);
});
