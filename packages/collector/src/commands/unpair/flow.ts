import { Effect } from "effect";

import { Secrets } from "../../capabilities/secrets/secrets.ts";
import { readConfig, writeConfig } from "../../modules/config/config.ts";
import { resolveDataDir } from "../../modules/data-dir/data-dir.ts";
import { readLedgerStatus, withLedger } from "../../modules/ledger/ledger.ts";
import { SnorlaxPlatform } from "../../modules/platform/platform.ts";

/**
 * One `snorlax unpair` (plan 3.1, 3.4.2). The device token is deleted first; a keychain failure changes
 * nothing else, so a retry can still delete the token. Then `backendUrl` is removed and `deviceName` stays,
 * and under the ledger lock the remote rows are cleared. Local buckets stay. No ledger means there is no
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
  yield* withLedger(platform, dataDir, (ledger) => ledger.resetRemote());
});
