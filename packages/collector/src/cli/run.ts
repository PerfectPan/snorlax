import { ChildProcessSpawner } from "effect/process";
import { CliConfig, CliError, Command, GlobalFlag } from "effect/cli";
import { Console, Effect, FileSystem, Layer, Option, Path, Runtime, Terminal } from "effect";
import { layerTest as stdioLayerTest } from "effect/Stdio";

import type { Scheduler } from "../capabilities/scheduler/scheduler.ts";
import { errorMessage } from "../core/error-message/error-message.ts";
import { resolveDataDir } from "../modules/data-dir/data-dir.ts";
import { appendingLogger } from "../modules/log/log.ts";
import { NodeFiles, SnorlaxPlatform } from "../modules/platform/platform.ts";
import { RuntimeInfo } from "../modules/version/version.ts";
import { CliEnv } from "./env.ts";
import { FAILURES, UNMAPPED, type FailureExit } from "./failures.ts";
import { cliConsole, printFailureJson, printFailureMessage, printHuman, printPayloadJson } from "./output.ts";
import { CommandOutput, JsonFlag, rootCommand } from "./root.ts";

/**
 * The `snorlax` invocation (plan 3.2.1, 3.13): one command, one exit. `effect/cli` parses the
 * command line and renders help, usage errors and version through its default formatter; command
 * failures are rendered here, so `--json` keeps exactly one JSON object on stdout. Every printed
 * byte is redacted in `cli/output.ts`. Exit codes: 0 success, 1 failure with the failure shape,
 * 2 invalid arguments.
 */

/**
 * The process exit carried out of the program. The exit-code marker is what `Runtime.defaultTeardown`
 * reads in `bin.ts`; `errorReported` says the truth — every failure reaching this class has already
 * been rendered by `cli/` (defects included), so a runtime logger must not report it again.
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
  /** Human mode flushes effect/cli's buffered rendering; JSON mode drops it for the envelope. */
  readonly output: "json" | "human";
}

/** What the caller provides: the platform, the file ops, the scheduler implementation and the sinks. */
type CliBase = SnorlaxPlatform | NodeFiles | Scheduler | CliEnv;

/**
 * Everything one invocation runs on, around the caller's `base`: the command handoff and what effect/cli
 * itself needs. The flows read the platform, the file ops and the scheduler themselves; `provideMerge`
 * keeps `base` exposed to the program.
 */
function cliLayersOf(base: Layer.Layer<CliBase>) {
  const services = Layer.mergeAll(
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
    // The parsed --json value reaches the handlers through runWith itself; this default only
    // satisfies the type at the top and reads as human mode where no run provided it.
    Layer.mergeAll(services, Layer.succeed(JsonFlag, false)),
    base
  );
}

/**
 * Runs one CLI invocation over `argv` (without the program name). Always fails with `CliExit`,
 * carrying the exit code; stdout and stderr carry the output. `base` provides the platform, the
 * file-ops seam, the scheduler and the output sinks — the Node platform and the system's scheduler in
 * `bin.ts`, memory doubles and a fake scheduler in tests.
 */
export const runCli = (argv: readonly string[], base: Layer.Layer<CliBase>): Effect.Effect<never, CliExit> =>
  Effect.gen(function* () {
    const platform = yield* SnorlaxPlatform;
    const env = yield* CliEnv;
    const info = yield* RuntimeInfo;
    const home = platform.home;
    // The output mode follows the value effect/cli actually parsed, which the handler hands over in
    // its render. Where no handler ran — a parse failure or a built-in action — the mode falls back
    // to the tokens before `--`, which is the best the raw line can say (a `--json` behind `--` is a
    // positional, not the flag).
    const fallbackJson = argv
      .slice(0, argv.includes("--") ? argv.indexOf("--") : argv.length)
      .some((token) => token === "--json" || token === "--json=true");
    const startedAt = platform.clock.monotonic();
    const commandName = argv.find((token) => !token.startsWith("-"));
    let failureCode: string | undefined;
    let dataDirRefused: true | undefined;

    // effect/cli renders help and parse errors through the Console while it runs, but the parsed
    // `--json` value is known only afterwards, so every rendering is buffered first and flushed to
    // the streams once the mode is decided — dropped entirely when a JSON envelope goes out instead.
    const buffered: { readonly out: string[]; readonly err: string[] } = { out: [], err: [] };
    const consoleImpl: Console.Console = cliConsole(home, buffered);

    // A command failure or defect: the JSON envelope or the message on stderr. An exit-2 failure drops
    // effect/cli's buffered rendering in both modes.
    const renderFailure = ({ code, exit, refusesDataDir }: FailureExit, message: string): Outcome => {
      failureCode = code;
      dataDirRefused = refusesDataDir;
      if (fallbackJson) {
        printFailureJson(env, home, code, message);
      } else {
        printFailureMessage(env, home, message);
      }
      return { exit, output: exit === 2 || fallbackJson ? "json" : "human" };
    };

    const program = Effect.gen(function* () {
      yield* Command.runWith(rootCommand, { version: info.version, renderErrors: true })([...argv]);
      const output = yield* (yield* CommandOutput).take;
      if (Option.isNone(output)) {
        // A built-in action (--help/--version) ran: effect/cli rendered it through the Console.
        // With --json that rendering is dropped and the run reports the unusable combination.
        if (fallbackJson) {
          printFailureJson(env, home, "invalid-arguments", "--help/--version is not available with --json");
          return { exit: 2, output: "json" } satisfies Outcome;
        }
        return { exit: 0, output: "human" } satisfies Outcome;
      }
      if (output.value.json) {
        printPayloadJson(env, home, output.value.payload);
        return { exit: 0, output: "json" } satisfies Outcome;
      }
      printHuman(env, home, output.value.human);
      return { exit: 0, output: "human" } satisfies Outcome;
    }).pipe(
      Effect.provideService(Console.Console, consoleImpl),
      Effect.catchDefect((defect) => Effect.succeed(renderFailure(UNMAPPED, errorMessage(defect)))),
      Effect.catch((error): Effect.Effect<Outcome> => {
        // Parse and usage errors arrive as ShowHelp: help text was already rendered through the
        // Console above (buffered when --json), the error details too when not suppressed.
        if (error instanceof CliError.ShowHelp) {
          if (error.errors.length === 0) {
            return Effect.succeed({ exit: 0, output: "human" });
          }
          failureCode = "invalid-arguments";
          if (fallbackJson) {
            printFailureJson(env, home, failureCode, error.errors.map((parseError) => parseError.message).join("; "));
            return Effect.succeed({ exit: 2, output: "json" });
          }
          return Effect.succeed({ exit: 2, output: "human" });
        }
        return Effect.succeed(
          renderFailure(CliError.isCliError(error) ? UNMAPPED : FAILURES[error._tag], errorMessage(error))
        );
      })
    );

    const outcome = yield* program;

    if (outcome.output === "human") {
      for (const text of buffered.out) {
        env.stdout.write(text);
      }
      for (const text of buffered.err) {
        env.stderr.write(text);
      }
    }

    const exitCode = outcome.exit;
    if (commandName !== undefined && COMMAND_NAMES.has(commandName) && dataDirRefused !== true) {
      const log = appendingLogger(platform, yield* NodeFiles, resolveDataDir(platform));
      yield* log.event("command", {
        name: commandName,
        exitCode,
        ...(failureCode === undefined ? {} : { error: failureCode }),
        durationMs: Math.round(platform.clock.monotonic() - startedAt)
      });
    }
    return yield* Effect.fail(new CliExit(exitCode));
  }).pipe(
    Effect.provide(cliLayersOf(base)),
    // Only help and version stay built in: --wizard would start an interactive prompt (plan 3.1
    // allows none), and --completions/--log-level are not part of the snorlax calling convention.
    Effect.provide(CliConfig.layer({ builtIns: [GlobalFlag.Help, GlobalFlag.Version] }))
  );
