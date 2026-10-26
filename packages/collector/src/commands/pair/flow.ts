import type { RefreshResult } from "@rivus/snorlax-protocol";
import type { Platform } from "@rivus/agent-kit/platform";
import { Data, Effect } from "effect";
import * as z from "zod/mini";

import {
  Backend,
  BackendForbidden,
  BackendInvalidResponse,
  BackendUnauthorized,
  BackendUnreachable,
  type BackendFailure,
  pairedSync
} from "../../capabilities/backend/backend.ts";
import { Secrets } from "../../capabilities/secrets/secrets.ts";
import { errorMessage } from "../../core/error-message/error-message.ts";
import {
  ConfigWriteFailed,
  backendUrlSchema,
  readConfig,
  writeConfig,
  type ConfigValue
} from "../../modules/config/config.ts";
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
import { adminTokenSchema, adminTokenText } from "./token.ts";

/** `--url`, `--name`, or the admin token on stdin cannot be used. Exit 2. */
export class PairUsage extends Data.TaggedError("PairUsage")<{ readonly message: string }> {}

/**
 * Revoke succeeded and registering again was still HTTP 409. Exit 1, `conflict`. The first 409 is not this:
 * `pair` revokes that id with the admin token and registers once more.
 */
export class PairConflict extends Data.TaggedError("PairConflict")<{ readonly message: string }> {}

/**
 * Registration succeeded and the device token was not stored. The device stays registered on the backend.
 * Running `pair` again revokes that id and registers once more. Exit 1, `keychain`.
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
  /** The id was already registered. `pair` revoked it and registered again. */
  readonly reregistered: boolean;
  readonly sync?: RefreshResult["sync"];
  readonly refreshNote?: string;
}

/** Human text and the pair log. The admin token is not in it. */
export const REREGISTERED =
  "this device was already registered; the old registration was revoked and the device was registered again";

type PrepareFailure =
  | LedgerPlatformUnsupported
  | LedgerLockHeld
  | LedgerUnreadable
  | LedgerSchemaTooNew
  | LedgerBackupFailed;

const alreadyRegistered = (deviceId: string): string => `device ${deviceId} is already registered`;

/**
 * What is still on disk after the token was stored and `config.json` was not written. A first pair has no
 * backend URL, so the device is not paired. A re-pair leaves the previous URL in place and the keychain
 * already holds the new token.
 */
const configLeftAs = (existing: ConfigValue): string =>
  existing.backendUrl === undefined
    ? "config was not written, so this device is not paired"
    : "config.json still has the previous backend URL and the keychain has the new token";

/** The ledger step failed before config was written. The tag stays, so the exit code still names the cause. */
const prepareFailed = (deviceId: string, existing: ConfigValue, error: PrepareFailure): PrepareFailure => {
  const message =
    `${alreadyRegistered(deviceId)} The token was stored. Buckets were not marked dirty, remote rows were ` +
    `not reset, and ${configLeftAs(existing)} (${error.message}).`;
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

const saveConfig = (
  platform: Platform,
  dataDir: string,
  backendUrl: string,
  deviceName: string,
  deviceId: string,
  existing: ConfigValue
) =>
  writeConfig(platform, dataDir, { ...existing, backendUrl, deviceName }).pipe(
    Effect.mapError(
      (error) =>
        new ConfigWriteFailed({
          message:
            `${error.message} ${alreadyRegistered(deviceId)} The token was stored. Every local bucket was ` +
            "marked dirty and remote rows were reset. " +
            (existing.backendUrl === undefined
              ? "config.json was not written, so this device is not paired."
              : "config.json still has the previous backend URL and the keychain has the new token.")
        })
    )
  );

const REVOKED_RECOVERY =
  "The old registration was revoked. This device shows revoked until pair is run again, and running pair once more recovers it.";

/** Keeps the failure tag. The second registration's own 409 is `PairConflict` and is not passed here. */
const explainRevoked = (error: BackendFailure): BackendFailure => {
  const message = `${error.message} ${REVOKED_RECOVERY}`;
  switch (error._tag) {
    case "BackendUnreachable":
      return new BackendUnreachable({ message });
    case "BackendUnauthorized":
      return new BackendUnauthorized({ message });
    case "BackendForbidden":
      return new BackendForbidden({ message });
    case "BackendInvalidResponse":
      return new BackendInvalidResponse({ message });
  }
};

const refreshPaired = (input: {
  readonly platform: Platform;
  readonly nodeFiles: NodeFileOps;
  readonly dataDir: string;
  readonly deviceId: string;
  readonly name: string;
  readonly reregistered: boolean;
}) =>
  Effect.gen(function* () {
    const log = appendingLogger(input.platform, input.nodeFiles, input.dataDir);
    yield* log.event(
      "pair",
      input.reregistered
        ? { deviceId: input.deviceId, name: input.name, reregistered: true, message: REREGISTERED }
        : { deviceId: input.deviceId, name: input.name }
    );
    const noteRefreshFailed = (message: string) => {
      const paired = {
        deviceId: input.deviceId,
        name: input.name,
        reregistered: input.reregistered,
        refreshNote: message
      } satisfies Paired;
      return log
        .event("pair", {
          deviceId: input.deviceId,
          name: input.name,
          refresh: "failed",
          message
        })
        .pipe(
          Effect.as(paired),
          // The pairing is already on disk. A log write that dies must not turn it into `internal`.
          Effect.catchDefect(() => Effect.succeed(paired))
        );
    };
    // `Effect.catch` does not catch defects. A throw inside the refresh would otherwise leave `pair` as
    // `internal` after config.json was written.
    return yield* Effect.gen(function* () {
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
        Effect.map(
          ({ result }) =>
            ({
              deviceId: input.deviceId,
              name: input.name,
              reregistered: input.reregistered,
              sync: result.sync
            }) satisfies Paired
        )
      );
    }).pipe(
      Effect.catch((error) => noteRefreshFailed(error.message)),
      Effect.catchDefect((defect) => noteRefreshFailed(errorMessage(defect)))
    );
  });

/**
 * One `snorlax pair` (plan 3.4.2). The URL and the admin token are checked before anything is created. An
 * admin token that is not an RFC 6750 bearer token is a usage error and the value is not printed. `config.json`
 * is read next: an invalid file fails before registration, so nothing is stored and nothing is marked dirty.
 * The ledger is then opened so the device id exists, and `POST /v1/devices` runs. A failed registration writes
 * no config, stores no token, and does not mark buckets dirty or reset remote rows; the ledger from the
 * device-id step may remain. After the token is stored, every local bucket is marked dirty and remote rows
 * are cleared under the ledger lock, and `config.json` is written last: that write is what counts as paired.
 * A failure of the locked step leaves the token stored. On a first pair the device is not paired; on a re-pair
 * the previous backend URL is still in `config.json` and the keychain has the new token. A failure of the
 * config write says the buckets were already marked and remote rows were reset, and names that same state.
 * A refresh failure after the write, including a defect, stays in the result and does not fail `pair`. A 409
 * revokes this id with the admin token and registers again; uploaded buckets stay and the old token stops
 * working. Only a second 409 is `conflict`. If that second registration fails, the error says the old
 * registration was revoked and one more `pair` recovers it. The pair log line names the device and not the
 * admin token.
 */
export const pairFlow = (input: { readonly url: string; readonly name: string }) =>
  Effect.gen(function* () {
    const adminToken = adminTokenText(yield* (yield* PairStdin).text);
    if (adminToken === "") {
      return yield* new PairUsage({ message: "the admin token on stdin is empty" });
    }
    if (!z.safeParse(adminTokenSchema, adminToken).success) {
      return yield* new PairUsage({ message: "the admin token on stdin is not an RFC 6750 bearer token" });
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
    const existing = yield* readConfig(platform, dataDir);
    yield* ensureDataDir(platform, nodeFiles, dataDir);
    const deviceId = yield* withLedger(platform, dataDir, (ledger) => Effect.succeed(ledger.meta.deviceId));
    const backend = yield* Backend;
    const device = { deviceId, name: input.name };
    // A 409 means this id is registered and not revoked (unpair, a new URL, a lost token). The caller already
    // gave the admin token, so revoke and register once more. A 409 from the revoke itself is not that
    // conflict: `BackendConflict` has no CLI code, and the call is not a second registration.
    const registered = yield* backend.registerDevice(url.data, adminToken, device).pipe(
      Effect.map((result) => ({ deviceToken: result.deviceToken, reregistered: false })),
      Effect.catchTag("BackendConflict", () =>
        backend.revokeDevice(url.data, adminToken, deviceId).pipe(
          Effect.catchTag("BackendConflict", (error) =>
            Effect.fail(new BackendInvalidResponse({ message: error.message }))
          ),
          Effect.flatMap(() =>
            backend.registerDevice(url.data, adminToken, device).pipe(
              Effect.map((result) => ({ deviceToken: result.deviceToken, reregistered: true })),
              Effect.catchTag("BackendConflict", () =>
                Effect.fail(
                  new PairConflict({ message: `device ${deviceId} is still registered after it was revoked` })
                )
              ),
              Effect.mapError((error) => (error._tag === "PairConflict" ? error : explainRevoked(error)))
            )
          )
        )
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
    ).pipe(Effect.mapError((error) => prepareFailed(deviceId, existing, error)));
    yield* saveConfig(platform, dataDir, url.data, input.name, deviceId, existing);
    return yield* refreshPaired({
      platform,
      nodeFiles,
      dataDir,
      deviceId,
      name: input.name,
      reregistered: registered.reregistered
    });
  });
