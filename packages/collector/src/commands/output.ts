import { Context, Effect, Layer, Option } from "effect";

/**
 * What a command produced on success: `payload` is the protocol shape with `schemaVersion` and
 * `ok: true`; `human` is the plain-text rendering printed when `--json` was not given (it includes
 * the trailing newline). The handler hands it to this service and returns — printing, redaction and
 * the `--json` decision belong to `cli/` (plan 3.13). A run that ends without any handler output is
 * a built-in action (`--help`, `--version`): `effect/cli` has rendered it already, and `take` says
 * so with `None` instead of failing.
 */
export interface CommandRender {
  readonly payload: object;
  readonly human: string;
}

/** The one-slot handoff from the command handler to the CLI framework: exactly one handler runs per process. */
export class CommandOutput extends Context.Service<
  CommandOutput,
  {
    readonly render: (output: CommandRender) => Effect.Effect<void>;
    readonly take: Effect.Effect<Option.Option<CommandRender>>;
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
        take: Effect.suspend(() => Effect.succeed(held === undefined ? Option.none() : Option.some(held)))
      });
    })
  );
}
