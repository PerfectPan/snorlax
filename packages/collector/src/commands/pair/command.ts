import { Data, Effect } from "effect";

/** This build has no pairing. */
class PairNotImplemented extends Data.TaggedError("PairNotImplemented")<{ readonly message: string }> {}

/**
 * Pairing arrives with Batch 7 (plan 3.4.2); the command is registered so that calling it returns
 * the standard failure shape instead of "unknown command".
 */
export const pairCommand = {
  name: "pair",
  description: "pair with a backend; arrives with Batch 7",
  flags: {},
  run: () =>
    Effect.fail(
      new PairNotImplemented({
        message: "snorlax pair is not implemented in this build; it arrives with Batch 7"
      })
    )
};
