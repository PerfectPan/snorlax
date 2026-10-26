import type { Platform } from "@rivus/agent-kit/platform";
import type { Bucket } from "@rivus/snorlax-protocol";
import type { Context } from "effect";
import { Effect } from "effect";

import type { BucketRow, RemoteBucketRow, RemoteDeviceRow } from "../../core/buckets/buckets.ts";
import { readConfig, type ConfigInvalid } from "../../modules/config/config.ts";
import { type Ledger, type LedgerUnreadable, type SyncReport } from "../../modules/ledger/ledger.ts";
import type { Secrets } from "../secrets/secrets.ts";
import type { Backend, BackendCallFailure } from "./backend.ts";

/**
 * How many dirty rows one push sends. Plan 3.2.4 allows 1–200; the client never sends more, and it does not
 * send a push when nothing is dirty.
 */
export const PUSH_BATCH = 200;

/** `GET /v1/buckets` page size in production. The API maximum is 1000; tests pass a smaller `pullLimit`. */
const DEFAULT_PULL_LIMIT = 1000;

export interface SyncInput {
  readonly platform: Platform;
  readonly dataDir: string;
  /** Page size for the pull. Defaults to `DEFAULT_PULL_LIMIT`. */
  readonly pullLimit?: number;
}

type SecretStore = Context.Service.Shape<typeof Secrets>;
type BackendClient = Context.Service.Shape<typeof Backend>;

const toBucket = (deviceId: string, row: BucketRow): Bucket => ({
  deviceId,
  hour: row.hour,
  agent: row.agent,
  model: row.model,
  inputTokens: row.inputTokens,
  cacheReadTokens: row.cacheReadTokens,
  cacheWriteTokens: row.cacheWriteTokens,
  outputTokens: row.outputTokens,
  reasoningTokens: row.reasoningTokens,
  requests: row.requests,
  sessionsStarted: row.sessionsStarted,
  costUsd: row.costUsd,
  unpricedRequests: row.unpricedRequests
});

/**
 * Push, pull, then refresh the device list (plan 3.4.1 step 6). Runs after the scan commits and before the
 * snapshot, on the caller's ledger lock. No SQLite transaction stays open across a request, and a batch's
 * dirty flag is cleared only after that batch's push returns 200, so a failure keeps the rows for the next
 * run. The scan result is already committed by then.
 *
 * The pull body has no per-row sequence (plan 3.2.4). A page that returns rows sets `next` to the last
 * row's seq; only an empty page sets `next` to null. Each stored row takes that high-water mark (`next`,
 * or the request's `after` when `next` is null). `meta.pull_cursor` moves to every non-null `next` after
 * the upsert, and the client keeps pulling until `next` is null, so the next refresh starts after the rows
 * already stored. A crash before the cursor write retries the page; the upsert is idempotent. Rows for
 * this device are skipped.
 */
export const synchronize = (
  input: SyncInput & {
    readonly secrets: SecretStore;
    readonly backend: BackendClient;
    readonly ledger: Ledger;
  }
): Effect.Effect<SyncReport, ConfigInvalid | LedgerUnreadable> =>
  Effect.gen(function* () {
    const config = yield* readConfig(input.platform, input.dataDir);
    // Unpaired runs, including the bundle tests, must not start `security`. The URL is checked first.
    if (config.backendUrl === undefined) {
      return { state: "unpaired", pushed: 0, pulled: 0, at: null };
    }
    const read = yield* input.secrets.read(input.ledger.meta.deviceId).pipe(
      Effect.match({
        onFailure: (error) => ({ kind: "error" as const, error }),
        onSuccess: (value) => ({ kind: "value" as const, value })
      })
    );
    // A missing item is "not paired". A keychain that cannot be read is a failed sync: the snapshot is
    // still written, and the `keychain` failure code stays for pair, unpair and doctor.
    if (read.kind === "error") {
      return {
        state: "failed",
        pushed: 0,
        pulled: 0,
        at: new Date(input.platform.clock.now()).toISOString(),
        message: read.error.message
      };
    }
    const token = read.value;
    if (token === undefined) {
      return { state: "unpaired", pushed: 0, pulled: 0, at: null };
    }
    const at = new Date(input.platform.clock.now()).toISOString();
    const baseUrl = config.backendUrl;
    const deviceId = input.ledger.meta.deviceId;
    let pushed = 0;
    let pulled = 0;
    const reportFor = (error: BackendCallFailure): SyncReport => ({
      state: error._tag === "BackendUnauthorized" ? "revoked" : "failed",
      pushed,
      pulled,
      at,
      message: error.message
    });

    let batch = yield* input.ledger.readDirtyBuckets(PUSH_BATCH);
    while (batch.length > 0) {
      const outcome = yield* input.backend
        .pushBuckets(
          baseUrl,
          token,
          deviceId,
          batch.map((row) => toBucket(deviceId, row))
        )
        .pipe(
          Effect.match({
            onFailure: (error) => ({ kind: "error" as const, error }),
            onSuccess: (value) => ({ kind: "value" as const, value })
          })
        );
      if (outcome.kind === "error") {
        return reportFor(outcome.error);
      }
      yield* input.ledger.clearDirty(batch.map((row) => ({ hour: row.hour, agent: row.agent, model: row.model })));
      pushed += batch.length;
      if (batch.length < PUSH_BATCH) {
        break;
      }
      batch = yield* input.ledger.readDirtyBuckets(PUSH_BATCH);
    }

    const limit = input.pullLimit ?? DEFAULT_PULL_LIMIT;
    let after = input.ledger.meta.pullCursor;
    for (;;) {
      const outcome = yield* input.backend.pullBuckets(baseUrl, token, after, limit).pipe(
        Effect.match({
          onFailure: (error) => ({ kind: "error" as const, error }),
          onSuccess: (value) => ({ kind: "value" as const, value })
        })
      );
      if (outcome.kind === "error") {
        return reportFor(outcome.error);
      }
      const page = outcome.value;
      const seq = page.next ?? after;
      const rows: RemoteBucketRow[] = [];
      for (const bucket of page.buckets) {
        if (bucket.deviceId === deviceId) {
          continue;
        }
        rows.push({ ...bucket, seq });
      }
      if (rows.length > 0) {
        yield* input.ledger.upsertRemoteBuckets(rows);
      }
      pulled += rows.length;
      if (page.next === null) {
        break;
      }
      yield* input.ledger.setPullCursor(page.next);
      after = page.next;
    }

    const listed = yield* input.backend.listDevices(baseUrl, token).pipe(
      Effect.match({
        onFailure: (error) => ({ kind: "error" as const, error }),
        onSuccess: (value) => ({ kind: "value" as const, value })
      })
    );
    if (listed.kind === "error") {
      return reportFor(listed.error);
    }
    const devices: RemoteDeviceRow[] = listed.value.map((device) => ({
      id: device.id,
      name: device.name,
      lastPushAt: device.lastPushAt === null ? null : Date.parse(device.lastPushAt),
      revoked: device.revoked
    }));
    yield* input.ledger.replaceRemoteDevices(devices);
    return { state: "ok", pushed, pulled, at };
  });
