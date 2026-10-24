import type { RefreshResult } from "@rivus/snorlax-protocol";

import { SnorlaxPlatform } from "../../modules/platform/platform.ts";
import { Context, Effect, Layer } from "effect";

import { ConfigInvalid } from "../../modules/config/config.ts";
import { DataDir, type DataDirCreateFailed } from "../../modules/data-dir/data-dir.ts";
import { Log, type Logger } from "../../modules/log/log.ts";
import { TimeZone } from "../../modules/time-zone/time-zone.ts";
import {
  LedgerBackupFailed,
  LedgerLockHeld,
  LedgerPlatformUnsupported,
  LedgerSchemaTooNew,
  LedgerUnreadable,
  refreshPlatformOf
} from "../../modules/ledger/ledger.ts";
import { SnapshotWriteFailed } from "../../modules/snapshot-file/snapshot-file.ts";
import { runRefresh } from "./refresh.ts";

type RefreshFailure =
  | LedgerLockHeld
  | LedgerPlatformUnsupported
  | LedgerUnreadable
  | LedgerSchemaTooNew
  | LedgerBackupFailed
  | ConfigInvalid
  | SnapshotWriteFailed;

/** Keeps what the modules under `runRefresh` throw on purpose as typed failures; any other rejection is a defect. */
const refreshFailure = (defect: unknown): Effect.Effect<never, RefreshFailure> =>
  defect instanceof LedgerLockHeld ||
  defect instanceof LedgerPlatformUnsupported ||
  defect instanceof LedgerUnreadable ||
  defect instanceof LedgerSchemaTooNew ||
  defect instanceof LedgerBackupFailed ||
  defect instanceof ConfigInvalid ||
  defect instanceof SnapshotWriteFailed
    ? Effect.fail(defect)
    : Effect.die(defect);

/**
 * One `snorlax refresh` (plan 3.4.1): the service prepares the data directory (creating it and its
 * `logs` directory on first use — this is the command that owns that side effect), then takes the
 * lock, scans, commits and writes the snapshot through the plain orchestration in `refresh.ts`.
 * Building the layer does none of this.
 */
export class Refresh extends Context.Service<
  Refresh,
  {
    readonly run: Effect.Effect<RefreshResult, DataDirCreateFailed | RefreshFailure>;
  }
>()("snorlax/refresh/Refresh") {
  static readonly live = Layer.effect(
    Refresh,
    Effect.gen(function* () {
      const platform = yield* SnorlaxPlatform;
      const dataDir = yield* DataDir;
      const log: Logger = yield* Log;
      const timeZone = yield* TimeZone;
      return Refresh.of({
        run: Effect.andThen(
          dataDir.ensure,
          Effect.promise(
            async () =>
              (
                await runRefresh(
                  { platform: refreshPlatformOf(platform), dataDir: dataDir.path, log, timeZone },
                  undefined
                )
              ).result
          ).pipe(Effect.catchDefect(refreshFailure))
        )
      });
    })
  );
}
