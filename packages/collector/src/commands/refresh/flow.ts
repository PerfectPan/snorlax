import { Effect } from "effect";

import { pairedSync } from "../../capabilities/backend/backend.ts";
import { ensureDataDir, resolveDataDir } from "../../modules/data-dir/data-dir.ts";
import { scanAndCommit, type ScanRun } from "../../modules/ledger/ledger.ts";
import { appendingLogger } from "../../modules/log/log.ts";
import { NodeFiles, SnorlaxPlatform } from "../../modules/platform/platform.ts";
import { TimeZone } from "../../modules/time-zone/time-zone.ts";

/** The scan margin: records and sources this much before the last completed scan are read again, so the
 *  kit's 30-minute quiet window cannot leave a late record outside the scan (plan 3.4.1 step 3). */
const RESCAN_MARGIN_MS = 2 * 3_600_000;

/** Refresh's part of the scan-and-commit run: incremental from the saved scan state. */
export const refreshScan: ScanRun = {
  event: "refresh",
  window: (ledger) => {
    const lastScan = ledger.meta.lastScanCompletedAt;
    return { since: lastScan === null ? 0 : lastScan - RESCAN_MARGIN_MS, state: ledger.scanState };
  }
};

/**
 * One `snorlax refresh` (plan 3.4.1): prepares the data directory (creating it and its `logs` directory on
 * first use — this is a command that owns that side effect), then scans incrementally from the saved scan
 * state through the ledger's scan-and-commit.
 */
export const refreshFlow = Effect.gen(function* () {
  const platform = yield* SnorlaxPlatform;
  const nodeFiles = yield* NodeFiles;
  const dataDir = resolveDataDir(platform);
  yield* ensureDataDir(platform, nodeFiles, dataDir);
  const log = appendingLogger(platform, nodeFiles, dataDir);
  const sync = yield* pairedSync({ platform, dataDir });
  return yield* scanAndCommit({ platform, dataDir, log, timeZone: yield* TimeZone, sync }, refreshScan);
});
