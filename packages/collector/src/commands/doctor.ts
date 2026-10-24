import { Command } from "effect/cli";
import { Effect } from "effect";

import { Doctor } from "../doctor/service.ts";
import { JsonFlag } from "./flags.ts";
import { CommandOutput } from "./output.ts";

/**
 * `snorlax doctor` (plan 3.1): local checks only in this milestone — Node version, data directory
 * and config. The command exits 0 whenever it completes; `healthy` reports whether any check failed.
 * Rendering and redaction of the human text belong to `cli/`.
 */
export const doctorCommand = Command.make("doctor", {}, () =>
  Effect.gen(function* () {
    const json = yield* JsonFlag;
    const payload = yield* (yield* Doctor).run;
    const human = payload.checks.map((check) => `${check.id}: ${check.status} — ${check.detail}`).join("\n");
    yield* (yield* CommandOutput).render({ payload, human: `${human}\n`, json });
  })
).pipe(Command.withDescription("local checks: node version, data directory, config"));
