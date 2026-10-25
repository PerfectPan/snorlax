import { Command, Flag, GlobalFlag } from "effect/cli";
import { Context, Data, Effect, Layer, Option } from "effect";

import { doctorCommand } from "../commands/doctor/command.ts";
import { installCommand } from "../commands/install/command.ts";
import { pairCommand } from "../commands/pair/command.ts";
import { rebuildCommand } from "../commands/rebuild/command.ts";
import { refreshCommand } from "../commands/refresh/command.ts";
import { snapshotCommand } from "../commands/snapshot/command.ts";
import { statusCommand } from "../commands/status/command.ts";
import { uninstallCommand } from "../commands/uninstall/command.ts";
import { unpairCommand } from "../commands/unpair/command.ts";

/**
 * The global `--json` flag as an effect/cli Setting: effect/cli parses it once per invocation and
 * provides the parsed value to the command handler as this service, so the output mode follows what
 * was actually parsed — `--json=false`, `--json no`, `--json --no-json` and `--no-json --json` all
 * mean human output — not what an argv scan guesses. The handler `commandOf` builds hands the value
 * on with the command's result; `cli/run` falls back to scanning the tokens before `--` only where no
 * handler ran.
 */
export const JsonFlag = GlobalFlag.Setting("json")({
  flag: Flag.Boolean("json").pipe(
    Flag.withDefault(false),
    Flag.withDescription("print one JSON object on stdout instead of human-readable text")
  )
});

/**
 * What a command produced on success: `payload` is the protocol shape with `schemaVersion` and
 * `ok: true`; `human` is the plain-text rendering printed when `--json` was not given (it includes
 * the trailing newline). Printing, redaction and the `--json` decision belong to `cli/` (plan 3.13).
 * A run that ends without any handler output is a built-in action (`--help`, `--version`):
 * `effect/cli` has rendered it already, and `take` says so with `None` instead of failing.
 */
export interface CommandRender {
  readonly payload: object;
  readonly human: string;
  /** The parsed `--json` value: `cli/run` prints `payload` when true, `human` when false. */
  readonly json: boolean;
  /**
   * The command deleted what snorlax wrote in the data directory (`uninstall --data`), so the run writes nothing
   * back into it, not even the command log line.
   */
  readonly deletedDataDir?: true;
}

/** The one-slot handoff from the command handler to `cli/run`: exactly one handler runs per process. */
export class CommandOutput extends Context.Service<
  CommandOutput,
  {
    readonly render: (output: CommandRender) => Effect.Effect<void>;
    readonly take: Effect.Effect<Option.Option<CommandRender>>;
  }
>()("snorlax/cli/CommandOutput") {
  static readonly live: Layer.Layer<CommandOutput> = Layer.effect(
    CommandOutput,
    Effect.sync(() => {
      let held: CommandRender | undefined;
      return CommandOutput.of({
        render: (output) =>
          Effect.sync(() => {
            held = output;
          }),
        take: Effect.suspend(() => Effect.succeed(held === undefined ? Option.none() : Option.some(held)))
      });
    })
  );
}

/**
 * A command as each `commands/<name>/command.ts` exports it: name, help description and flags, and
 * `run`, which takes the parsed flags and only produces the result. `commands/` cannot import `cli/`
 * (plan 3.13 rule 1), so the commands match this shape structurally.
 */
interface CommandSpec<Name extends string, Flags extends Command.Command.Config, E, R> {
  readonly name: Name;
  readonly description: string;
  readonly flags: Flags;
  readonly run: (input: Command.Command.Config.Infer<Flags>) => Effect.Effect<Omit<CommandRender, "json">, E, R>;
}

/** The effect/cli command for a spec: its handler reads the parsed `--json` and hands the result to `CommandOutput`. */
const commandOf = <Name extends string, const Flags extends Command.Command.Config, E, R>(
  spec: CommandSpec<Name, Flags, E, R>
) =>
  Command.make(spec.name, spec.flags, (input) =>
    Effect.gen(function* () {
      const json = yield* JsonFlag;
      const result = yield* spec.run(input);
      yield* (yield* CommandOutput).render({ ...result, json });
    })
  ).pipe(Command.withDescription(spec.description));

/** The command line names no command. */
class UsageError extends Data.TaggedError("UsageError")<{ readonly message: string }> {}

/**
 * The root command (plan 3.13): the global `--json` flag is an effect/cli Setting, so it is accepted
 * both before and after the command name and its parsed value reaches the handler. The root's own handler only runs when no command was named and
 * fails as a usage error; every other parse failure (unknown command, unknown option, a missing or
 * malformed flag value) surfaces through `effect/cli` as a `ShowHelp` error, which `cli/run` maps to
 * exit 2 with the `invalid-arguments` code.
 */
export const rootCommand = Command.make("snorlax", {}, () =>
  Effect.fail(new UsageError({ message: "a command is required; run `snorlax --help` for the command list" }))
).pipe(
  Command.withGlobalFlags([JsonFlag]),
  Command.withDescription("read coding-agent usage logs and report tokens, requests, sessions and cost"),
  Command.withSubcommands([
    commandOf(statusCommand),
    commandOf(doctorCommand),
    commandOf(snapshotCommand),
    commandOf(refreshCommand),
    commandOf(rebuildCommand),
    commandOf(pairCommand),
    commandOf(unpairCommand),
    commandOf(installCommand),
    commandOf(uninstallCommand)
  ])
);
