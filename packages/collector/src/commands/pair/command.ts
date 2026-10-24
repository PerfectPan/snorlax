import { Command } from "effect/cli";
import { Data, Effect } from "effect";

/** This build has no pairing. */
class PairNotImplemented extends Data.TaggedError("PairNotImplemented")<{ readonly message: string }> {}

/**
 * Pairing arrives with Batch 7 (plan 3.4.2); the command is registered so that calling it returns
 * the standard failure shape instead of "unknown command".
 */
export const pairCommand = Command.make("pair", {}, () =>
  Effect.fail(
    new PairNotImplemented({
      message: "snorlax pair is not implemented in this build; it arrives with Batch 7"
    })
  )
).pipe(Command.withDescription("pair with a backend; arrives with Batch 7"));
