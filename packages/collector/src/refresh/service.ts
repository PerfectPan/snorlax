import type { RefreshResult } from "@rivus/snorlax-protocol";

import { SnorlaxPlatform } from "../platform.ts";
import { Context, Effect, Layer } from "effect";

import { DataDir } from "../data-dir/data-dir.ts";
import type { CollectorPlatform } from "../platform.ts";
import { CommandError } from "../errors.ts";
import type { PlatformSqlite } from "../ledger/sqlite.ts";
import { Log, type Logger } from "../log/logger.ts";
import { TimeZone } from "../time-zone.ts";
import { errorMessage } from "../util/error-message.ts";
import type { RefreshPlatform } from "./lock.ts";
import { runRefresh } from "./refresh.ts";

/**
 * Widens the platform into what a refresh runs on. SQLite is required (the ledger); the process
 * identity members are read by the ledger lock inside the kit's own try/catch, so a platform without
 * them gets members that throw — on the Node platform none of the fallbacks are used.
 */
export function refreshPlatformOf(platform: CollectorPlatform): RefreshPlatform {
  if (platform.sqlite === undefined) {
    throw new CommandError({ code: "internal", message: "this platform has no SQLite; the ledger cannot run here" });
  }
  const sqlite: PlatformSqlite = platform.sqlite;
  const unavailable = (member: "self" | "identify" | "spawn") => (): never => {
    throw new CommandError({
      code: "internal",
      message: `this platform has no process.${member}; the ledger lock cannot run here`
    });
  };
  const identityOf = platform.process;
  return {
    env: platform.env,
    home: platform.home,
    os: platform.os,
    fs: platform.fs,
    clock: platform.clock,
    sqlite,
    process: {
      run: identityOf.run,
      get self() {
        // `self` is a value on the kit's platform, read lazily here so a platform whose identity read
        // throws (the kit treats that as "no identity") still takes the lock.
        const identity = identityOf.self;
        if (identity === undefined) {
          throw new Error("this platform has no process identity; the ledger lock records none");
        }
        return identity;
      },
      identify: identityOf.identify ?? unavailable("identify"),
      spawn: identityOf.spawn ?? unavailable("spawn")
    }
  };
}

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
