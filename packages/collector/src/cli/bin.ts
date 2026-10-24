import process from "node:process";

import { NodePlatformLive } from "@rivus/agent-kit/node/effect";
import { Effect, Layer, Runtime } from "effect";

import { NodeFiles, SnorlaxPlatform } from "../modules/platform/platform.ts";
import { CliEnv } from "./env.ts";
import { runCli } from "./run.ts";

/**
 * The `snorlax` bin (plan 3.13): composes the Node layers — the kit platform through
 * `NodePlatformLive`, the real file ops, the process streams — and runs one command.
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

/**
 * The runner keeps the kernel's signal semantics (plan 3.2.1: a timed-out command must end by
 * signal, which is how the app's CollectorClient tells its timeout apart from a bad result).
 * `NodeRuntime.runMain` would exit(130) instead, so this copies what it does with one difference:
 * on SIGINT/SIGTERM the fiber is interrupted first — layers and databases release — and once it has
 * exited the same signal is re-raised at this process, which therefore ends BY the signal.
 */
const fiber = Effect.runFork(runCli(process.argv.slice(2), liveLayers));
let signaled: NodeJS.Signals | undefined;
const relay = (signal: NodeJS.Signals): void => {
  signaled = signal;
  process.removeListener(signal, relay);
  fiber.interruptUnsafe();
};
process.on("SIGINT", relay);
process.on("SIGTERM", relay);
fiber.addObserver((exit) => {
  process.removeListener("SIGINT", relay);
  process.removeListener("SIGTERM", relay);
  if (signaled !== undefined) {
    process.kill(process.pid, signaled);
    return;
  }
  Runtime.defaultTeardown(exit, (code) => {
    if (code !== 0) {
      process.exitCode = code;
    }
  });
});
