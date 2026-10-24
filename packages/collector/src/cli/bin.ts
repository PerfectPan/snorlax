import process from "node:process";

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { NodePlatformLive } from "@rivus/agent-kit/node/effect";
import { Effect, Layer } from "effect";
import { Stdio } from "effect/Stdio";

import { NodeFiles } from "../data-dir/node-fs.ts";
import { SnorlaxPlatform } from "../platform.ts";
import { CliEnv } from "./env.ts";
import { runCli } from "./run.ts";

/**
 * The `snorlax` bin (plan 3.13): composes the Node layers — the kit platform through
 * `NodePlatformLive`, the real file ops, the process streams — and runs one command with
 * `NodeRuntime.runMain`, whose teardown reads the exit code this CLI puts on its `CliExit` failure.
 */
const liveLayers = Layer.mergeAll(
  Layer.provideMerge(SnorlaxPlatform.fromKitPlatform, NodePlatformLive),
  NodeFiles.live,
  Layer.succeed(
    CliEnv,
    CliEnv.of({
      stdout: process.stdout,
      stderr: process.stderr,
      // Human failure text takes color only on a terminal that has not opted out.
      colors: process.stderr.isTTY === true && process.env.NO_COLOR === undefined
    })
  )
);

const program = Effect.gen(function* () {
  const args = yield* Stdio.use((stdio) => stdio.args);
  return yield* runCli(args, liveLayers);
}).pipe(Effect.provide(NodeServices.layer));

program.pipe(NodeRuntime.runMain({ disableErrorReporting: true }));
