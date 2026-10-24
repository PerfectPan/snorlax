import { Data, Effect } from "effect";

/** This build has no pairing to remove. */
class UnpairNotImplemented extends Data.TaggedError("UnpairNotImplemented")<{ readonly message: string }> {}

/** Unpairing arrives with Batch 7 (plan 3.1). */
export const unpairCommand = {
  name: "unpair",
  description: "remove the backend pairing; arrives with Batch 7",
  flags: {},
  run: () =>
    Effect.fail(
      new UnpairNotImplemented({
        message: "snorlax unpair is not implemented in this build; it arrives with Batch 7"
      })
    )
};
