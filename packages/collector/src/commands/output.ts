import { Context, Effect, Layer } from "effect";

import { CommandError } from "../errors.ts";

/**
 * What a command produced on success: `payload` is the protocol shape with `schemaVersion` and
 * `ok: true`; `human` is the plain-text rendering printed when `--json` was not given (it includes
 * the trailing newline). The handler hands it to this service and returns — printing, redaction and
 * the `--json` decision belong to `cli/` (plan 3.13).
 */
export interface CommandRender {
  readonly payload: object;
  readonly human: string;
}

/**
 * The one-slot handoff from the command handler to the CLI framework: exactly one handler runs per
 * process, so a single slot is enough, and a run whose handler never rendered is an `internal`
 * failure instead of a silent exit.
 */
export class CommandOutput extends Context.Service<
  CommandOutput,
  {
    readonly render: (output: CommandRender) => Effect.Effect<void>;
    readonly take: Effect.Effect<CommandRender, CommandError>;
  }
>()("snorlax/commands/CommandOutput") {
  static readonly live: Layer.Layer<CommandOutput> = Layer.effect(
    CommandOutput,
    Effect.sync(() => {
      let held: CommandRender | undefined;
      return CommandOutput.of({
        render: (output) =>
          Effect.sync(() => {
            held = output;
          }),
        take: Effect.suspend((): Effect.Effect<CommandRender, CommandError> =>
          held === undefined
            ? Effect.fail(new CommandError({ code: "internal", message: "the command produced no output" }))
            : Effect.succeed(held)
        )
      });
    })
  );
}
