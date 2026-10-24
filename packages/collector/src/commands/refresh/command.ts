import { Effect } from "effect";

import { refreshFlow } from "./flow.ts";

const humanSummary = (scannedAt: string, records: number, failures: number): string =>
  [
    `scanned ${records} records at ${scannedAt}, ${failures} failures`,
    // Sync arrives with Batch 7; until then every refresh reports the device as not paired.
    "sync: not paired"
  ].join("\n");

/** `snorlax refresh` (plan 3.1, 3.4.1): scan, commit the ledger, write the snapshot. */
export const refreshCommand = {
  name: "refresh",
  description: "scan agent usage since the last run, update the ledger, write the snapshot",
  flags: {},
  run: () =>
    Effect.map(refreshFlow, ({ result }) => ({
      payload: result,
      human: `${humanSummary(result.scannedAt, result.records, result.failures)}\n`
    }))
};
