import type { RefreshResult } from "@rivus/snorlax-protocol";

import { accumulateRecord, createAccumulator } from "../../core/buckets/buckets.ts";
import type { Logger } from "../log/log.ts";
import { collectUsage, type ScanOutcome } from "../scan/scan.ts";
import type { Ledger, PersistedScanState } from "./ledger.ts";
import type { RefreshPlatform } from "./lock.ts";

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
