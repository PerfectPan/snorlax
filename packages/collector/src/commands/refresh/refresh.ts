import { readConfig } from "../../modules/config/config.ts";
import {
  commitScan,
  openLedger,
  withLedgerLock,
  type RefreshDeps,
  type RefreshOutcome,
  type ScanHooks
} from "../../modules/ledger/ledger.ts";
import { buildSnapshot } from "../../core/snapshot/snapshot.ts";
import { writeSnapshot } from "../../modules/snapshot-file/snapshot-file.ts";

/** The scan margin: records and sources this much before the last completed scan are read again, so the
 *  kit's 30-minute quiet window cannot leave a late record outside the scan (plan 3.4.1 step 3). */
export const RESCAN_MARGIN_MS = 2 * 3_600_000;

/**
 * One `snorlax refresh` (plan 3.4.1 steps 2–8, minus the sync of step 6 that arrives with Batch 7): take
 * the ledger lock, open the ledger under it, scan incrementally, commit buckets and scan state in one
 * transaction, then build and atomically write the snapshot. Opening under the lock puts the migration,
 * the meta write and the read of meta and scan state after the previous run's commit, so two overlapping
 * runs queue instead of the second reading the first's pre-commit state. The scan result stays committed
 * even when the snapshot write fails; the next refresh rewrites the snapshot.
 */
export async function runRefresh(deps: RefreshDeps, hooks?: ScanHooks): Promise<RefreshOutcome> {
  const startedAt = deps.platform.clock.monotonic();
  return withLedgerLock(deps.platform, deps.dataDir, async () => {
    const now = deps.platform.clock.now();
    const ledger = await openLedger(deps.platform, deps.dataDir);
    try {
      const lastScan = ledger.meta.lastScanCompletedAt;
      const outcome = await commitScan({
        platform: deps.platform,
        ledger,
        now,
        since: lastScan === null ? 0 : lastScan - RESCAN_MARGIN_MS,
        state: ledger.scanState,
        hooks
      });
      const config = await readConfig(deps.platform, deps.dataDir);
      const snapshot = buildSnapshot({
        now,
        timeZone: deps.timeZone,
        thisDevice: { id: ledger.meta.deviceId, name: config.deviceName ?? null },
        buckets: ledger.readBuckets(),
        remoteBuckets: ledger.readRemoteBuckets(),
        remoteDevices: ledger.readRemoteDevices(),
        lastScanAt: now,
        failuresByAgent: outcome.failuresByAgent,
        paired: false
      });
      await writeSnapshot(deps.platform, deps.dataDir, snapshot);
      await deps.log.event("refresh", {
        records: outcome.records,
        failures: outcome.failures,
        pushed: 0,
        pulled: 0,
        durationMs: Math.round(deps.platform.clock.monotonic() - startedAt)
      });
      return {
        result: {
          schemaVersion: 1,
          ok: true,
          scannedAt: new Date(now).toISOString(),
          records: outcome.records,
          failures: outcome.failures,
          // Not paired in this milestone: the sync fields say no sync ran (Batch 7 pairs a backend).
          sync: { ok: false, pushed: 0, pulled: 0 }
        },
        failuresByAgent: outcome.failuresByAgent
      };
    } finally {
      ledger.close();
    }
  });
}
