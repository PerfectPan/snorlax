import { Effect } from "effect";

import { Secrets, storeProgramMissingNotice } from "../../capabilities/secrets/secrets.ts";
import { buildSnapshot } from "../../core/snapshot/snapshot.ts";
import { readConfig, writeConfig } from "../../modules/config/config.ts";
import { resolveDataDir } from "../../modules/data-dir/data-dir.ts";
import { readLedgerStatus, withLedger } from "../../modules/ledger/ledger.ts";
import { appendingLogger } from "../../modules/log/log.ts";
import { NodeFiles, SnorlaxPlatform } from "../../modules/platform/platform.ts";
import { writeSnapshot } from "../../modules/snapshot-file/snapshot-file.ts";
import { TimeZone } from "../../modules/time-zone/time-zone.ts";

/**
 * One `snorlax unpair` (plan 3.1, 3.4.2). The device token is deleted first; a keychain failure changes
 * nothing else, so a retry can still delete the token. A missing store program does not abort the command:
 * the human output and the log say a stored token was not deleted. Then `backendUrl` is removed and
 * `deviceName` stays.
 * Under the ledger lock the remote rows are cleared and `snapshot.json` is rebuilt from the ledger, without
 * a scan, so the app sees `paired: false` immediately. Scan failure counts are not stored, so that rewrite
 * leaves `failuresByAgent` empty until the next scan. Local buckets stay. No ledger means there is no
 * device id: the command succeeds and creates nothing.
 */
export const unpairFlow = Effect.gen(function* () {
  const platform = yield* SnorlaxPlatform;
  const dataDir = resolveDataDir(platform);
  const status = yield* readLedgerStatus(platform, dataDir);
  if (status === null) {
    return undefined;
  }
  const deleted = yield* (yield* Secrets).delete(status.deviceId).pipe(
    Effect.match({
      onFailure: (error) => error,
      onSuccess: () => undefined
    })
  );
  let notice: string | undefined;
  if (deleted !== undefined) {
    if (deleted._tag !== "StoreBinaryMissing") {
      return yield* deleted;
    }
    notice = storeProgramMissingNotice(deleted.command);
    yield* appendingLogger(platform, yield* NodeFiles, dataDir).event("keychain", { message: notice });
  }
  const existing = yield* readConfig(platform, dataDir);
  if (existing.backendUrl !== undefined) {
    yield* writeConfig(platform, dataDir, existing.deviceName === undefined ? {} : { deviceName: existing.deviceName });
  }
  const timeZone = yield* TimeZone;
  yield* withLedger(platform, dataDir, (ledger) =>
    Effect.gen(function* () {
      yield* ledger.resetRemote();
      const config = yield* readConfig(platform, dataDir);
      const snapshot = buildSnapshot({
        now: platform.clock.now(),
        timeZone,
        thisDevice: { id: ledger.meta.deviceId, name: config.deviceName ?? null },
        buckets: yield* ledger.readBuckets(),
        remoteBuckets: yield* ledger.readRemoteBuckets(),
        remoteDevices: yield* ledger.readRemoteDevices(),
        lastScanAt: ledger.meta.lastScanCompletedAt,
        failuresByAgent: {},
        sync: { state: "unpaired", at: null }
      });
      yield* writeSnapshot(platform, dataDir, snapshot);
    })
  );
  return notice;
});
