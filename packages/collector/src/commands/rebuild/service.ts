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
import { runRebuild } from "./rebuild.ts";

type RebuildFailure =
  | LedgerLockHeld
  | LedgerPlatformUnsupported
  | LedgerUnreadable
  | LedgerSchemaTooNew
  | LedgerBackupFailed
  | ConfigInvalid
  | SnapshotWriteFailed;

/** Keeps what the modules under `runRebuild` throw on purpose as typed failures; any other rejection is a defect. */
const rebuildFailure = (defect: unknown): Effect.Effect<never, RebuildFailure> =>
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
 * One `snorlax rebuild --days n` (plan 3.4.3): like `Refresh`, the service prepares the data
 * directory first, then zeroes and rescans the window through the plain orchestration in
 * `rebuild.ts`. Building the layer does none of this.
 */
export class Rebuild extends Context.Service<
  Rebuild,
  {
    readonly run: (days: number) => Effect.Effect<RefreshResult, DataDirCreateFailed | RebuildFailure>;
  }
>()("snorlax/rebuild/Rebuild") {
  static readonly live = Layer.effect(
    Rebuild,
    Effect.gen(function* () {
      const platform = yield* SnorlaxPlatform;
      const dataDir = yield* DataDir;
      const log: Logger = yield* Log;
      const timeZone = yield* TimeZone;
      return Rebuild.of({
        run: (days) =>
          Effect.andThen(
            dataDir.ensure,
            Effect.promise(
              async () =>
                (
                  await runRebuild(
                    { platform: refreshPlatformOf(platform), dataDir: dataDir.path, log, timeZone },
                    days
                  )
                ).result
            ).pipe(Effect.catchDefect(rebuildFailure))
          )
      });
    })
  );
}
