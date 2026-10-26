import process from "node:process";

import { NodePlatformLive } from "@rivus/agent-kit/node/effect";
import { Effect, Layer, Runtime } from "effect";

import { Backend } from "../capabilities/backend/backend.ts";
import { Scheduler, schedulerOs } from "../capabilities/scheduler/scheduler.ts";
import { Secrets } from "../capabilities/secrets/secrets.ts";
import { NodeFiles, SnorlaxPlatform } from "../modules/platform/platform.ts";
import { CliEnv } from "./env.ts";
import { runCli } from "./run.ts";

/**
 * The token store of this machine (plan 3.4.2). `platform.os` decides, not `SNORLAX_OS`: that override exists
 * so the Linux CI job can exercise launchd, and it must not point the keychain at a binary the machine lacks.
 */
const secretsLive = Layer.unwrap(
  Effect.gen(function* () {
    const platform = yield* SnorlaxPlatform;
    if (platform.os === "darwin") {
      return Secrets.keychain;
    }
    if (platform.os === "linux") {
      return Secrets.libsecret;
    }
    return Secrets.unavailable(platform.os);
  })
);

/**
 * The scheduler of the system the CLI runs on (plan 3.13 rule 5). `SNORLAX_OS` (`darwin`, `linux` or
 * `win32`), when set, stands in for `platform.os`, so the bundled CLI can run either scheduler on any CI
 * job; it is not copied into the job. Picking one only reads the environment, and the win32 implementation
 * fails install and uninstall alone, so every other command runs whatever `SNORLAX_OS` says.
 */
const schedulerLive = Layer.unwrap(
  Effect.gen(function* () {
    const os = schedulerOs(yield* SnorlaxPlatform);
    if (os === "darwin") {
      return Scheduler.launchd;
    }
    if (os === "linux") {
      return Scheduler.systemd;
    }
    if (os === "win32") {
      return Scheduler.unsupported(os);
    }
    // `platform.os` is always one of the three, so only the override names another system.
    return Scheduler.osOverrideInvalid;
  })
);

/**
 * The `snorlax` bin (plan 3.13): composes the Node layers — the kit platform through
 * `NodePlatformLive`, the real file ops, the scheduler of this system, the process streams — and runs
 * one command.
 */
const liveLayers = Layer.mergeAll(
  Layer.provideMerge(
    Layer.mergeAll(schedulerLive, secretsLive, Backend.live),
    Layer.provideMerge(SnorlaxPlatform.fromKitPlatform, NodePlatformLive)
  ),
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
 * A reader that closes stdout early (`snorlax status --json | head -c0`) does not make the command fail: the EPIPE
 * is dropped without printing anything, and the exit code stays the command's own. Any other stdout error still
 * ends the process as an uncaught exception.
 */
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code !== "EPIPE") {
    throw error;
  }
});

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
