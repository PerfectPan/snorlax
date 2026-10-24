import { Effect } from "effect";
import type { Snapshot } from "@rivus/snorlax-protocol";

import { snapshotFlow } from "./flow.ts";

const humanSummary = (snapshot: Snapshot): string => {
  const { totals } = snapshot;
  const window = (label: string, total: Snapshot["totals"]["today"]): string =>
    `${label}: ${total.tokens} tokens, $${total.costUsd.toFixed(2)}, ${total.requests} requests, ${total.sessions} sessions`;
  const topAgents = [...snapshot.byAgent]
    .sort((a, b) => b.today.tokens - a.today.tokens)
    .slice(0, 3)
    .map((agent) => `${agent.agent}=${agent.today.tokens}`)
    .join(" ");
  return [
    `generated at ${snapshot.generatedAt} (${snapshot.timeZone})`,
    window("today", totals.today),
    window("last 7 days", totals.last7d),
    window("last 30 days", totals.last30d),
    `top agents today: ${topAgents === "" ? "none" : topAgents}`
  ].join("\n");
};

/**
 * `snorlax snapshot` (plan 3.1): prints the current snapshot, wrapped as `SnapshotOutput`
 * (`{ schemaVersion, ok, snapshot }`) with `--json`. The snapshot is written by `refresh`, so a
 * fresh data directory has none yet and the command fails without creating anything.
 */
export const snapshotCommand = {
  name: "snapshot",
  description: "print the current snapshot",
  flags: {},
  run: () =>
    Effect.map(snapshotFlow, (snapshot) => ({
      payload: { schemaVersion: 1, ok: true, snapshot },
      human: `${humanSummary(snapshot)}\n`
    }))
};
