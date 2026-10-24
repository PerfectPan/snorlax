import { Command } from "effect/cli";
import { Effect } from "effect";

import { CommandError } from "../../modules/errors/errors.ts";

/** Unpairing arrives with Batch 7 (plan 3.1). */
export const unpairCommand = Command.make("unpair", {}, () =>
  Effect.fail(
    new CommandError({
      code: "internal",
      message: "snorlax unpair is not implemented in this build; it arrives with Batch 7"
    })
  )
).pipe(Command.withDescription("remove the backend pairing; arrives with Batch 7"));
