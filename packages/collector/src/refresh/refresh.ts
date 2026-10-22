import type { RefreshResult } from "@rivus/snorlax-protocol";

import { readConfig } from "../config/config.ts";
import type { Logger } from "../log/logger.ts";
import { accumulateRecord, createAccumulator } from "../buckets/accumulate.ts";
import type { Ledger, PersistedScanState } from "../ledger/ledger.ts";
import { openLedger } from "../ledger/ledger.ts";
import { buildSnapshot } from "../snapshot/build.ts";
import { writeSnapshot } from "../snapshot/write.ts";
import { collectUsage, type ScanOutcome } from "../scan/scan.ts";
import { withLedgerLock, type RefreshPlatform } from "./lock.ts";

/** Everything a refresh or rebuild needs besides the scan window. */
export interface RefreshDeps {
  readonly platform: RefreshPlatform;
  readonly dataDir: string;
  readonly log: Logger;
  /** IANA time zone of this device; the snapshot's day windows follow it (plan 3.2.2). */
  readonly timeZone: string;
}

/** Test seam for Spec S3: a run that dies after decoding and before the ledger transaction commits. */
export interface ScanHooks {
  readonly failBeforeCommit?: boolean;
}

/** The scan margin: records and sources this much before the last completed scan are read again, so the
 *  kit's 30-minute quiet window cannot leave a late record outside the scan (plan 3.4.1 step 3). */
export const RESCAN_MARGIN_MS = 2 * 3_600_000;

export interface CommitScanInput {
  readonly platform: RefreshPlatform;
  readonly ledger: Ledger;
  readonly now: number;
  readonly since: number;
  readonly state: PersistedScanState | undefined;
  /** Rebuild's zeroing and `sessions_seen` delete, inside the same transaction as the scan's writes. */
  readonly beforeScan?: (ledger: Ledger) => void;
  readonly hooks?: ScanHooks;
}

/**
 * Steps 3–5 of one refresh (plan 3.4.1): scan only what was written since `since`, fold every record into
 * hourly buckets, then — in one transaction — write the buckets, the sessions first seen, the new scan
 * state and `last_scan_completed_at`. The scan iterates inside the transaction, so a run that dies anywhere
 * before the commit leaves the ledger exactly as it was (Spec S3) — and a rebuild's zeroing, passed as
 * `beforeScan`, rolls back with it.
 */
export async function commitScan(input: CommitScanInput): Promise<ScanOutcome> {
  const accumulator = createAccumulator();
  return input.ledger.transaction(async () => {
    input.beforeScan?.(input.ledger);
    const seen = input.ledger.sessionsSeen();
    const outcome = await collectUsage(input.platform, { since: input.since, state: input.state }, (record) =>
      accumulateRecord(record, accumulator, seen)
    );
    input.ledger.addBuckets([...accumulator.buckets.values()]);
    input.ledger.addSessionsSeen(accumulator.newSessions);
    input.ledger.setScanState(outcome.state);
    input.ledger.setLastScanCompleted(input.now);
    if (input.hooks?.failBeforeCommit === true) {
      throw new Error("simulated crash between decode and commit (Spec S3)");
    }
    return outcome;
  });
}

export interface RefreshOutcome {
  readonly result: RefreshResult;
  readonly failuresByAgent: Record<string, number>;
}

/**
 * One `snorlax refresh` (plan 3.4.1 steps 2–8, minus the sync of step 6 that arrives with Batch 7): take
 * the ledger lock, scan incrementally, commit buckets and scan state in one transaction, then build and
 * atomically write the snapshot. The scan result stays committed even when the snapshot write fails; the
 * next refresh rewrites the snapshot.
 */
export async function runRefresh(deps: RefreshDeps, hooks?: ScanHooks): Promise<RefreshOutcome> {
  const startedAt = deps.platform.clock.monotonic();
  const now = deps.platform.clock.now();
  const ledger = await openLedger(deps.platform, deps.dataDir);
  try {
    return await withLedgerLock(deps.platform, deps.dataDir, async () => {
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
    });
  } finally {
    ledger.close();
  }
}
