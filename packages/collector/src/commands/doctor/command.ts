import { Effect } from "effect";

import { doctorFlow } from "./flow.ts";

/**
 * `snorlax doctor` (plan 3.1): Node version, data directory, config, the scheduled refresh, and, when
 * paired, the keychain and the backend. The command exits 0 whenever it completes; `healthy` reports
 * whether any check failed.
 */
export const doctorCommand = {
  name: "doctor",
  description: "checks: node, data directory, config, schedule, and the backend when paired",
  flags: {},
  run: () =>
    Effect.map(doctorFlow, (payload) => ({
      payload,
      human: `${payload.checks.map((check) => `${check.id}: ${check.status} — ${check.detail}`).join("\n")}\n`
    }))
};
