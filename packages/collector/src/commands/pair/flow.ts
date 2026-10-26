import type { RefreshResult } from "@rivus/snorlax-protocol";
import type { Platform } from "@rivus/agent-kit/platform";
import { Data, Effect } from "effect";
import * as z from "zod/mini";

import { Backend, pairedSync } from "../../capabilities/backend/backend.ts";
import { Secrets } from "../../capabilities/secrets/secrets.ts";
import { ConfigWriteFailed, backendUrlSchema, readConfig, writeConfig } from "../../modules/config/config.ts";
import { ensureDataDir, resolveDataDir } from "../../modules/data-dir/data-dir.ts";
import {
  LedgerBackupFailed,
  LedgerLockHeld,
  LedgerPlatformUnsupported,
  LedgerSchemaTooNew,
  LedgerUnreadable,
  refreshScan,
  scanAndCommit,
  withLedger
} from "../../modules/ledger/ledger.ts";
import { appendingLogger } from "../../modules/log/log.ts";
import { NodeFiles, SnorlaxPlatform, type NodeFileOps } from "../../modules/platform/platform.ts";
import { TimeZone } from "../../modules/time-zone/time-zone.ts";
import { PairStdin } from "./stdin.ts";
import { adminTokenText } from "./token.ts";

/** `--url`, `--name`, or the admin token on stdin cannot be used. Exit 2. */
export class PairUsage extends Data.TaggedError("PairUsage")<{ readonly message: string }> {}

/** This device id is already registered and has not been revoked. Exit 1, `conflict`. */
export class PairConflict extends Data.TaggedError("PairConflict")<{ readonly message: string }> {}

/**
 * Registration succeeded and the device token was not stored. The device stays registered on the backend
 * until it is revoked with the admin token. Exit 1, `keychain`.
 */
export class PairTokenNotStored extends Data.TaggedError("PairTokenNotStored")<{ readonly message: string }> {}

const URL_USAGE = "--url must be an https URL, or http on localhost, 127.0.0.1, or [::1]";

/**
 * A finished pair. `sync` is set when the refresh produced a report. `refreshNote` is set when the refresh
 * failed before it could report. Pairing itself has already succeeded in both cases.
 */
export interface Paired {
  readonly deviceId: string;
  readonly name: string;
  readonly sync?: RefreshResult["sync"];
  readonly refreshNote?: string;
}

type PrepareFailure =
  | LedgerPlatformUnsupported
  | LedgerLockHeld
  | LedgerUnreadable
  | LedgerSchemaTooNew
  | LedgerBackupFailed;

const alreadyRegistered = (deviceId: string): string =>
  `device ${deviceId} is already registered; revoke this id with the admin token, then pair again`;

/** The ledger step failed before config was written. The tag stays, so the exit code still names the cause. */
const prepareFailed = (deviceId: string, error: PrepareFailure): PrepareFailure => {
  const message =
    `${alreadyRegistered(deviceId)} The token was stored. Buckets were not marked dirty, remote rows were ` +
    `not reset, and config was not written, so this device is not paired (${error.message}).`;
  switch (error._tag) {
    case "LedgerPlatformUnsupported":
      return new LedgerPlatformUnsupported({ message });
    case "LedgerLockHeld":
      return new LedgerLockHeld({ message });
    case "LedgerUnreadable":
      return new LedgerUnreadable({ message });
    case "LedgerSchemaTooNew":
      return new LedgerSchemaTooNew({ message });
    case "LedgerBackupFailed":
      return new LedgerBackupFailed({ message });
  }
};

const saveConfig = (platform: Platform, dataDir: string, backendUrl: string, deviceName: string, deviceId: string) =>
  Effect.gen(function* () {
    const existing = yield* readConfig(platform, dataDir);
    yield* writeConfig(platform, dataDir, { ...existing, backendUrl, deviceName }).pipe(
      Effect.mapError(
        (error) =>
          new ConfigWriteFailed({
            message:
              `${error.message} ${alreadyRegistered(deviceId)} The token was stored. Every local bucket was ` +
              "marked dirty and remote rows were reset. config.json was not written, so this device is not paired."
          })
      )
    );
  });

const refreshPaired = (input: {
  readonly platform: Platform;
  readonly nodeFiles: NodeFileOps;
  readonly dataDir: string;
  readonly deviceId: string;
  readonly name: string;
}) =>
  Effect.gen(function* () {
    const log = appendingLogger(input.platform, input.nodeFiles, input.dataDir);
    yield* log.event("pair", { deviceId: input.deviceId, name: input.name });
    const sync = yield* pairedSync({ platform: input.platform, dataDir: input.dataDir });
    const timeZone = yield* TimeZone;
    return yield* scanAndCommit(
      {
        platform: input.platform,
        dataDir: input.dataDir,
        log,
        timeZone,
        sync
      },
      refreshScan
    ).pipe(
      Effect.map(({ result }) => ({ deviceId: input.deviceId, name: input.name, sync: result.sync }) satisfies Paired),
      // Pairing is already done. A lock, a scan, or a snapshot failure must not make `pair` exit 1.
      Effect.catch((error) =>
        log
          .event("pair", {
            deviceId: input.deviceId,
            name: input.name,
            refresh: "failed",
            message: error.message
          })
          .pipe(
            Effect.as({
              deviceId: input.deviceId,
              name: input.name,
              refreshNote: error.message
            } satisfies Paired)
          )
      )
    );
  });

/**
 * One `snorlax pair` (plan 3.4.2). The URL and the admin token are checked before anything is created. The
 * ledger is then opened so the device id exists, and `POST /v1/devices` runs. A failed registration writes
 * no config, stores no token, and does not mark buckets dirty or reset remote rows; the ledger from the
 * device-id step may remain. After the token is stored, every local bucket is marked dirty and remote rows
 * are cleared under the ledger lock, and `config.json` is written last: that write is what counts as paired.
 * A failure of the locked step leaves the token stored and the device not paired. A failure of the config
 * write says the buckets were already marked and remote rows were reset. A refresh failure after the write,
 * sync report or otherwise, stays in the result and does not fail `pair`. The pair log line names the device
 * and not the admin token.
 */
export const pairFlow = (input: { readonly url: string; readonly name: string }) =>
  Effect.gen(function* () {
    const adminToken = adminTokenText(yield* (yield* PairStdin).text);
    if (adminToken === "") {
      return yield* new PairUsage({ message: "the admin token on stdin is empty" });
    }
    if (input.name === "") {
      return yield* new PairUsage({ message: "--name must not be empty" });
    }
    const url = z.safeParse(backendUrlSchema, input.url);
    if (!url.success) {
      return yield* new PairUsage({ message: URL_USAGE });
    }
    const platform = yield* SnorlaxPlatform;
    const nodeFiles = yield* NodeFiles;
    const dataDir = resolveDataDir(platform);
    yield* ensureDataDir(platform, nodeFiles, dataDir);
    const deviceId = yield* withLedger(platform, dataDir, (ledger) => Effect.succeed(ledger.meta.deviceId));
    const backend = yield* Backend;
    const registered = yield* backend
      .registerDevice(url.data, adminToken, { deviceId, name: input.name })
      .pipe(
        Effect.catchTag("BackendConflict", () =>
          Effect.fail(new PairConflict({ message: alreadyRegistered(deviceId) }))
        )
      );
    yield* (yield* Secrets).store(deviceId, registered.deviceToken).pipe(
      Effect.catchTag("KeychainUnavailable", (error) =>
        Effect.fail(
          new PairTokenNotStored({
            message: `${alreadyRegistered(deviceId)} The token could not be stored (${error.message}).`
          })
        )
      )
    );
    yield* withLedger(platform, dataDir, (ledger) =>
      Effect.gen(function* () {
        yield* ledger.markAllDirty();
        yield* ledger.resetRemote();
      })
    ).pipe(Effect.mapError((error) => prepareFailed(deviceId, error)));
    yield* saveConfig(platform, dataDir, url.data, input.name, deviceId);
    return yield* refreshPaired({ platform, nodeFiles, dataDir, deviceId, name: input.name });
  });
