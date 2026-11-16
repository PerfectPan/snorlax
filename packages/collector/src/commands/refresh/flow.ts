import { Effect } from "effect";

import { preparedScanContext } from "../../capabilities/backend/backend.ts";
import { refreshScan, scanAndCommit } from "../../modules/ledger/ledger.ts";
import { TimeZone } from "../../modules/time-zone/time-zone.ts";

/**
 * One `snorlax refresh`: prepares the data directory (creating it and its `logs` directory on
 * first use — this is a command that owns that side effect), then scans incrementally from the saved scan
 * state through the ledger's scan-and-commit.
 */
export const refreshFlow = Effect.gen(function* () {
  const { platform, dataDir, log, sync } = yield* preparedScanContext;
  return yield* scanAndCommit({ platform, dataDir, log, timeZone: yield* TimeZone, sync }, refreshScan);
});
