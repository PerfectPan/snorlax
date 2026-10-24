import { Command } from "effect/cli";
import { Effect } from "effect";

import { CommandError } from "../errors.ts";

/**
 * Pairing arrives with Batch 7 (plan 3.4.2); the command is registered so that calling it returns
 * the standard failure shape instead of "unknown command".
 */
export const pairCommand = Command.make("pair", {}, () =>
  Effect.fail(
    new CommandError({
      code: "internal",
      message: "snorlax pair is not implemented in this build; it arrives with Batch 7"
    })
  )
).pipe(Command.withDescription("pair with a backend; arrives with Batch 7"));
