import type { Doctor } from "@rivus/snorlax-protocol";
import { Effect } from "effect";

import { doctorFlow } from "./flow.ts";

/**
 * `snorlax doctor` (plan 3.1, R13): Node version, data directory, config, the scheduled refresh, and,
 * when paired, the keychain and the backend. The command completes with the same payload either way
 * and exits 0 healthy, 1 unhealthy; the human verdict line and `healthy` say which.
 */

/** The final human line, on `healthy`'s own terms: only an error is a problem; a warning is not. */
export const doctorVerdict = (payload: Doctor): string => {
  if (payload.healthy) {
    return "doctor: healthy";
  }
  const errors = payload.checks.filter((check) => check.status === "error").length;
  const warnings = payload.checks.filter((check) => check.status === "warn").length;
  const counts = [
    errors === 1 ? "1 error" : `${errors} errors`,
    ...(warnings === 0 ? [] : warnings === 1 ? ["1 warning"] : [`${warnings} warnings`])
  ].join(", ");
  const noun = errors === 1 ? "problem" : "problems";
  return `doctor: ${errors} ${noun} found (${counts})`;
};

const humanDoctor = (payload: Doctor): string =>
  [
    payload.checks.map((check) => `${check.id}: ${check.status} — ${check.detail}`).join("\n"),
    "",
    doctorVerdict(payload)
  ].join("\n");

export const doctorCommand = {
  name: "doctor",
  description: "checks: node, data directory, config, schedule, and the backend when paired",
  flags: {},
  run: () =>
    Effect.map(doctorFlow, (payload) => ({
      payload,
      human: `${humanDoctor(payload)}\n`,
      ...(payload.healthy ? {} : { exitCode: 1 })
    }))
};
