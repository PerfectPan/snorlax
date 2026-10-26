import { Effect } from "effect";

import { Secrets } from "../../capabilities/secrets/secrets.ts";
import { buildSnapshot } from "../../core/snapshot/snapshot.ts";
import { readConfig, writeConfig } from "../../modules/config/config.ts";
import { resolveDataDir } from "../../modules/data-dir/data-dir.ts";
import { readLedgerStatus, withLedger } from "../../modules/ledger/ledger.ts";
import { SnorlaxPlatform } from "../../modules/platform/platform.ts";
import { writeSnapshot } from "../../modules/snapshot-file/snapshot-file.ts";
import { TimeZone } from "../../modules/time-zone/time-zone.ts";

/**
 * One `snorlax unpair` (plan 3.1, 3.4.2). The device token is deleted first; a keychain failure changes
 * nothing else, so a retry can still delete the token. Then `backendUrl` is removed and `deviceName` stays.
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
    return;
  }
  yield* (yield* Secrets).delete(status.deviceId);
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
});
