import { SnorlaxPlatform } from "../platform.ts";
import { Context, Effect, Layer } from "effect";

import { DataDir } from "../data-dir/data-dir.ts";
import { CommandError } from "../errors.ts";
import { errorMessage } from "../util/error-message.ts";
import { installLaunchAgent, uninstallLaunchAgent, type UninstallResult } from "./launchd.ts";

/**
 * The LaunchAgent as a service, over the plain orchestration in `launchd.ts`; the real `launchctl`
 * is never started by tests, which point `SNORLAX_LAUNCHCTL` at a stub. `install` prepares the data
 * directory — but only after the ownership check has accepted the loaded service, so a refused
 * install builds nothing (plan 3.13). `uninstall` prepares nothing at all: it only removes known
 * entries, and both the kit's `fs.remove` and the leftovers handling treat a missing data directory
 * or a missing `logs/` directory as already clean.
 */
export class Schedule extends Context.Service<
  Schedule,
  {
    readonly install: Effect.Effect<string, CommandError>;
    readonly uninstall: (options: { readonly deleteData: boolean }) => Effect.Effect<UninstallResult, CommandError>;
  }
>()("snorlax/schedule/Schedule") {
  static readonly live = Layer.effect(
    Schedule,
    Effect.gen(function* () {
      const platform = yield* SnorlaxPlatform;
      const dataDir = yield* DataDir;
      const asCommandError = (error: unknown): CommandError =>
        error instanceof CommandError ? error : new CommandError({ code: "internal", message: errorMessage(error) });
      return Schedule.of({
        install: Effect.tryPromise({
          try: () => installLaunchAgent(platform, dataDir.path, () => Effect.runPromise(dataDir.ensure)),
          catch: asCommandError
        }),
        uninstall: (options) =>
          Effect.tryPromise({
            try: () => uninstallLaunchAgent(platform, dataDir.path, options),
            catch: asCommandError
          })
      });
    })
  );
}
