import { SnorlaxPlatform } from "../platform.ts";
import { Context, Effect, Layer } from "effect";

import { DataDir } from "../data-dir/data-dir.ts";
import { CommandError } from "../errors.ts";
import { errorMessage } from "../util/error-message.ts";
import { installLaunchAgent, uninstallLaunchAgent, type UninstallResult } from "./launchd.ts";

/**
 * The LaunchAgent as a service. Both operations prepare the data directory first (like every writing
 * command, so a refused install still leaves the machine in the state `uninstall --data` expects),
 * then go through the plain orchestration in `launchd.ts`; the real `launchctl` is never started by
 * tests, which point `SNORLAX_LAUNCHCTL` at a stub.
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
        install: Effect.andThen(
          dataDir.ensure,
          Effect.tryPromise({
            try: () => installLaunchAgent(platform, dataDir.path),
            catch: asCommandError
          })
        ),
        uninstall: (options) =>
          Effect.andThen(
            dataDir.ensure,
            Effect.tryPromise({
              try: () => uninstallLaunchAgent(platform, dataDir.path, options),
              catch: asCommandError
            })
          )
      });
    })
  );
}
