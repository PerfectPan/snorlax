import type { RefreshResult } from "@rivus/snorlax-protocol";

import { SnorlaxPlatform } from "../../modules/platform/platform.ts";
import { Context, Effect, Layer } from "effect";

import { DataDir } from "../../modules/data-dir/data-dir.ts";
import { CommandError } from "../../modules/errors/errors.ts";
import { Log, type Logger } from "../../modules/log/log.ts";
import { TimeZone } from "../../modules/time-zone/time-zone.ts";
import { errorMessage } from "../../core/error-message/error-message.ts";
import { refreshPlatformOf } from "../../modules/ledger/ledger.ts";
import { runRefresh } from "./refresh.ts";

/**
 * One `snorlax refresh` (plan 3.4.1): the service prepares the data directory (creating it and its
 * `logs` directory on first use — this is the command that owns that side effect), then takes the
 * lock, scans, commits and writes the snapshot through the plain orchestration in `refresh.ts`.
 * Building the layer does none of this.
 */
export class Refresh extends Context.Service<
  Refresh,
  {
    readonly run: Effect.Effect<RefreshResult, CommandError>;
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
          Effect.tryPromise({
            try: async () =>
              (
                await runRefresh(
                  { platform: refreshPlatformOf(platform), dataDir: dataDir.path, log, timeZone },
                  undefined
                )
              ).result,
            catch: (error) =>
              error instanceof CommandError
                ? error
                : new CommandError({ code: "internal", message: errorMessage(error) })
          })
        )
      });
    })
  );
}
