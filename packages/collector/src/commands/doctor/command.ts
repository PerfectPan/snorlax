import { Effect } from "effect";

import { doctorFlow } from "./flow.ts";

/**
 * `snorlax doctor` (plan 3.1): local checks only in this milestone — Node version, data directory
 * and config. The command exits 0 whenever it completes; `healthy` reports whether any check failed.
 */
export const doctorCommand = {
  name: "doctor",
  description: "local checks: node version, data directory, config",
  flags: {},
  run: () =>
    Effect.map(doctorFlow, (payload) => ({
      payload,
      human: `${payload.checks.map((check) => `${check.id}: ${check.status} — ${check.detail}`).join("\n")}\n`
    }))
};
