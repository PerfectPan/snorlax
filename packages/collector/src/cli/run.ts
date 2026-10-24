import { SnorlaxPlatform } from "../platform.ts";
import { ChildProcessSpawner } from "effect/process";
import { CliError, Command } from "effect/cli";
import { Console, Effect, FileSystem, Layer, Path, Runtime, Terminal } from "effect";
import { layerTest as stdioLayerTest } from "effect/Stdio";

import type { FailureCode } from "@rivus/snorlax-protocol";

import { ConfigStore } from "../config/config.ts";
import { DataDir } from "../data-dir/data-dir.ts";
import { NodeFiles } from "../data-dir/node-fs.ts";
import { Doctor } from "../doctor/service.ts";
import { CommandError, UsageError } from "../errors.ts";
import { Log } from "../log/logger.ts";
import { Rebuild } from "../rebuild/service.ts";
import { Refresh } from "../refresh/service.ts";
import { Schedule } from "../schedule/service.ts";
import { SnapshotStore } from "../snapshot/store.ts";
import { StatusReport } from "../status/report.ts";
import { CommandOutput } from "../commands/output.ts";
import { errorMessage } from "../util/error-message.ts";
import { RuntimeInfo } from "../version.ts";
import { CliEnv } from "./env.ts";
import {
  bufferedConsole,
  cliConsole,
  printFailureJson,
  printFailureMessage,
  printHuman,
  printPayloadJson
} from "./output.ts";
import { rootCommand } from "./root.ts";

/**
 * The `snorlax` invocation (plan 3.2.1, 3.13): one command, one exit. `effect/cli` parses the
 * command line and renders help, usage errors and version through its default formatter; command
 * failures are rendered here, so `--json` keeps exactly one JSON object on stdout. Every printed
 * byte is redacted in `cli/output.ts`. Exit codes: 0 success, 1 failure with the failure shape,
 * 2 invalid arguments.
 */

/**
 * The process exit carried out of the program. The marker is what the default teardown reads for the
 * exit code, and `errorReported` keeps the runner from logging a failure this CLI already rendered.
 */
export class CliExit extends Error {
  readonly [Runtime.errorExitCode]: number;
  readonly [Runtime.errorReported] = true;

  constructor(readonly exitCode: number) {
    super(`snorlax exited ${exitCode}`);
    this[Runtime.errorExitCode] = exitCode;
  }
}

const COMMAND_NAMES = new Set<string>([
  "status",
  "doctor",
  "snapshot",
  "refresh",
  "rebuild",
  "pair",
  "unpair",
  "install",
  "uninstall"
]);

/** What one invocation decided, after all streams were written. */
interface Outcome {
  readonly exit: number;
  /** In `--json` mode effect/cli's help rendering is buffered; a buffered help still goes out. */
  readonly flushConsole: boolean;
}

/**
 * The whole service graph of one invocation, built around the caller's `base`: `base` feeds DataDir
 * the platform and the sinks, DataDir feeds every feature layer, and Log feeds the refresh and
 * rebuild layers that write summary lines. The merges keep every service the invocation itself reads
 * exposed to the program.
 */
function cliLayersOf(base: Layer.Layer<SnorlaxPlatform | NodeFiles | CliEnv>) {
  const writers = Layer.provideMerge(Layer.mergeAll(Refresh.live, Rebuild.live), Log.live);
  const readers = Layer.mergeAll(
    ConfigStore.live,
    StatusReport.live,
    Doctor.live,
    SnapshotStore.live,
    Schedule.live,
    CommandOutput.live,
    // The services effect/cli itself needs; the collector goes through the kit platform, so the
    // file system here is only the inert requirement of the parser.
    FileSystem.layerNoop({}),
    Path.layer,
    stdioLayerTest({}),
    Layer.succeed(
      Terminal.Terminal,
      Terminal.make({
        columns: Effect.succeed(80),
        rows: Effect.succeed(24),
        readInput: Effect.die("unused"),
        readLine: Effect.die("unused"),
        display: () => Effect.void
      })
    ),
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => Effect.die("unused"))
    )
  );
  return Layer.provideMerge(
    Layer.mergeAll(writers, readers),
    Layer.provideMerge(Log.live, Layer.provideMerge(DataDir.live, base))
  );
}

/**
 * Runs one CLI invocation over `argv` (without the program name). Always fails with `CliExit`,
 * carrying the exit code; stdout and stderr carry the output. `base` provides the platform, the
 * file-ops seam and the output sinks — the Node platform in `bin.ts`, memory doubles in tests.
 */
export const runCli = (
  argv: readonly string[],
  base: Layer.Layer<SnorlaxPlatform | NodeFiles | CliEnv>
): Effect.Effect<never, CliExit> =>
  Effect.gen(function* () {
    const platform = yield* SnorlaxPlatform;
    const env = yield* CliEnv;
    const info = yield* RuntimeInfo;
    const home = platform.home;
    const json = argv.includes("--json");
    const startedAt = platform.clock.monotonic();
    const commandName = argv.find((token) => !token.startsWith("-"));
    let failureCode: string | undefined;

    // In `--json` mode effect/cli's help and version rendering is buffered and only flushed when it
    // is the thing the run was asked for, so a failed run still prints exactly one JSON object.
    const buffered: { readonly out: string[]; readonly err: string[] } = { out: [], err: [] };
    const consoleImpl: Console.Console = json ? bufferedConsole(buffered) : cliConsole(env);

    const program = Effect.gen(function* () {
      yield* Command.runWith(rootCommand, { version: info.version, renderErrors: true })([...argv]);
      const output = yield* (yield* CommandOutput).take;
      if (json) {
        printPayloadJson(env, home, output.payload);
      } else {
        printHuman(env, home, output.human);
      }
      return { exit: 0, flushConsole: false } satisfies Outcome;
    }).pipe(
      Effect.provideService(Console.Console, consoleImpl),
      Effect.catchDefect((defect) => new CommandError({ code: "internal", message: errorMessage(defect) })),
      Effect.catch((error): Effect.Effect<Outcome> => {
        // Parse and usage errors arrive as ShowHelp: help text was already rendered through the
        // Console above (buffered when --json), the error details too when not suppressed.
        if (error instanceof CliError.ShowHelp) {
          if (error.errors.length === 0) {
            return Effect.succeed({ exit: 0, flushConsole: true });
          }
          failureCode = "invalid-arguments";
          if (json) {
            printFailureJson(env, home, failureCode, error.errors.map((parseError) => parseError.message).join("; "));
          }
          return Effect.succeed({ exit: 2, flushConsole: false });
        }
        if (error instanceof UsageError) {
          failureCode = "invalid-arguments";
          if (json) {
            printFailureJson(env, home, failureCode, error.message);
          } else {
            printFailureMessage(env, home, error.message);
          }
          return Effect.succeed({ exit: 2, flushConsole: false });
        }
        const code: FailureCode = error instanceof CommandError ? error.code : "internal";
        failureCode = code;
        const message = errorMessage(error);
        if (json) {
          printFailureJson(env, home, code, message);
        } else {
          printFailureMessage(env, home, message);
        }
        return Effect.succeed({ exit: 1, flushConsole: false });
      })
    );

    const outcome = yield* program;

    if (json && outcome.flushConsole) {
      for (const text of buffered.out) {
        env.stdout.write(text);
      }
      for (const text of buffered.err) {
        env.stderr.write(text);
      }
    }

    const exitCode = outcome.exit;
    if (commandName !== undefined && COMMAND_NAMES.has(commandName)) {
      const log = yield* Log;
      yield* Effect.promise(() =>
        log.event("command", {
          name: commandName,
          exitCode,
          ...(failureCode === undefined ? {} : { error: failureCode }),
          durationMs: Math.round(platform.clock.monotonic() - startedAt)
        })
      );
    }
    return yield* Effect.fail(new CliExit(exitCode));
  }).pipe(Effect.provide(cliLayersOf(base)));
