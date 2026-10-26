import type { RefreshResult } from "@rivus/snorlax-protocol";
import { Effect } from "effect";

import { refreshFlow } from "./flow.ts";

const syncLine = (sync: RefreshResult["sync"]): string => {
  if (sync.state === "unpaired") {
    return "sync: not paired";
  }
  if (sync.state === "revoked") {
    return "sync: revoked";
  }
  return `sync: ${sync.state}, pushed ${sync.pushed}, pulled ${sync.pulled}`;
};

const humanSummary = (result: RefreshResult): string =>
  [`scanned ${result.records} records at ${result.scannedAt}, ${result.failures} failures`, syncLine(result.sync)].join(
    "\n"
  );

/** `snorlax refresh` (plan 3.1, 3.4.1): scan, commit the ledger, write the snapshot. */
export const refreshCommand = {
  name: "refresh",
  description: "scan agent usage since the last run, update the ledger, write the snapshot",
  flags: {},
  run: () =>
    Effect.map(refreshFlow, ({ result }) => ({
      payload: result,
      human: `${humanSummary(result)}\n`
    }))
};
