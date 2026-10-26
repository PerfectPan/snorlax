import { Context, type Effect } from "effect";

/**
 * The admin token text `pair` reads. `cli/run.ts` provides it: a test string on `CliEnv`, or `process.stdin`
 * for the bundled CLI. The effect is not started until `pair` yields it.
 */
export class PairStdin extends Context.Service<PairStdin, { readonly text: Effect.Effect<string> }>()(
  "snorlax/commands/pair/PairStdin"
) {}
