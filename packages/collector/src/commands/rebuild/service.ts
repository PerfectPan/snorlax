import type { RefreshResult } from "@rivus/snorlax-protocol";
import { SnorlaxPlatform } from "../../modules/platform/platform.ts";
import { Context, Effect, Layer } from "effect";

import { DataDir } from "../../modules/data-dir/data-dir.ts";
import { CommandError } from "../../modules/errors/errors.ts";
import { Log, type Logger } from "../../modules/log/log.ts";
import { TimeZone } from "../../modules/time-zone/time-zone.ts";
import { errorMessage } from "../../core/error-message/error-message.ts";
import { refreshPlatformOf } from "../../modules/ledger/ledger.ts";
import { runRebuild } from "./rebuild.ts";

/**
 * One `snorlax rebuild --days n` (plan 3.4.3): like `Refresh`, the service prepares the data
 * directory first, then zeroes and rescans the window through the plain orchestration in
 * `rebuild.ts`. Building the layer does none of this.
 */
export class Rebuild extends Context.Service<
  Rebuild,
  {
    readonly run: (days: number) => Effect.Effect<RefreshResult, CommandError>;
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
            Effect.tryPromise({
              try: async () =>
                (
                  await runRebuild(
                    { platform: refreshPlatformOf(platform), dataDir: dataDir.path, log, timeZone },
                    days
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
