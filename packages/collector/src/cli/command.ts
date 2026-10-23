import type { CliContext } from "./context.ts";

/** What a command produced on success. `payload` is the protocol shape with `schemaVersion` and `ok: true`. */
export interface CommandOutcome {
  readonly json: boolean;
  readonly payload: object;
  /** Human-readable text, printed to stdout when `--json` was not given; includes the trailing newline. */
  readonly human: string;
}

export interface Command {
  readonly id: string;
  readonly summary: string;
  run(args: readonly string[], ctx: CliContext): Promise<CommandOutcome>;
}
