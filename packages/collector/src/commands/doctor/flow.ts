import type { Platform } from "@rivus/agent-kit/platform";
import type { Doctor } from "@rivus/snorlax-protocol";
import { Effect } from "effect";

import { Backend } from "../../capabilities/backend/backend.ts";
import { Scheduler } from "../../capabilities/scheduler/scheduler.ts";
import { Secrets } from "../../capabilities/secrets/secrets.ts";
import { errorMessage } from "../../core/error-message/error-message.ts";
import { readConfig, type ConfigValue } from "../../modules/config/config.ts";
import { resolveDataDir } from "../../modules/data-dir/data-dir.ts";
import { readLedgerStatus } from "../../modules/ledger/ledger.ts";
import { NodeFiles, SnorlaxPlatform, type NodeFileOps } from "../../modules/platform/platform.ts";
import { RuntimeInfo } from "../../modules/version/version.ts";
import {
  backendChecks,
  configCheck,
  dataDirCheck,
  doctorPayload,
  nodeVersionCheck,
  scheduleCheck,
  type ConfigObservation,
  type DataDirObservation,
  type NodeBinary,
  type PairedBackendObservation
} from "./checks.ts";

/**
 * Runnable means a regular file, symlinks followed, with an execute bit set. The path comes from the plist, so it can
 * lie where this user cannot look; a `stat` or mode read that fails there (the kit's `stat` reads only ENOENT and
 * ENOTDIR as nothing at the path) is `unchecked` with its reason rather than a defect that ends `doctor`.
 */
const nodeBinaryAt = (
  platform: Pick<Platform, "fs">,
  nodeFiles: NodeFileOps,
  path: string
): Effect.Effect<NodeBinary> =>
  Effect.gen(function* () {
    const found = yield* Effect.promise(() => platform.fs.stat(path, { followSymlinks: true }));
    if (found === undefined) {
      return "missing";
    }
    const mode = yield* Effect.promise(() => nodeFiles.mode(path));
    return found.kind === "file" && mode !== undefined && (mode & 0o111) !== 0 ? "runnable" : "not-executable";
  }).pipe(Effect.catchDefect((defect) => Effect.succeed({ unchecked: errorMessage(defect) })));

type ConfigRead = { readonly ok: true; readonly value: ConfigValue } | { readonly ok: false; readonly message: string };

/** A failed read becomes an observation. `doctor` reports it and still exits 0. */
const caught = <A, E extends { readonly message: string }>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.map((value) => ({ ok: true as const, value })),
    Effect.catch((error) => Effect.succeed({ ok: false as const, message: error.message })),
    Effect.catchDefect((defect) => Effect.succeed({ ok: false as const, message: errorMessage(defect) }))
  );

/**
 * Keychain, health, and the device list for a paired config. Nothing here creates a file: a missing ledger
 * is a keychain error, and `GET /v1/devices` is not called when the token cannot be read.
 */
const pairedObservation = (
  platform: Platform,
  dataDir: string,
  backendUrl: string
): Effect.Effect<PairedBackendObservation, never, Secrets | Backend> =>
  Effect.gen(function* () {
    const secrets = yield* Secrets;
    const backend = yield* Backend;
    const ledger = yield* caught(readLedgerStatus(platform, dataDir));
    const deviceId = ledger.ok && ledger.value !== null ? ledger.value.deviceId : undefined;
    const read =
      !ledger.ok || deviceId === undefined
        ? undefined
        : yield* secrets.read(deviceId).pipe(
            Effect.map((value) => ({ ok: true as const, value })),
            Effect.catch((error) => Effect.succeed({ ok: false as const, message: error.message })),
            Effect.catchDefect((defect) => Effect.succeed({ ok: false as const, message: errorMessage(defect) }))
          );
    const token = read?.ok === true ? read.value : undefined;
    const keychain: PairedBackendObservation["keychain"] = !ledger.ok
      ? { kind: "unavailable", message: ledger.message }
      : deviceId === undefined
        ? { kind: "unavailable", message: "the ledger does not exist, so the device token was not read" }
        : read === undefined || !read.ok
          ? { kind: "unavailable", message: read?.message ?? "the device token was not read" }
          : token === undefined
            ? { kind: "missing" }
            : { kind: "present" };
    const healthResult = yield* caught(backend.health(backendUrl));
    const health: PairedBackendObservation["health"] = healthResult.ok
      ? { kind: "ok" }
      : { kind: "error", message: healthResult.message };
    const devices: PairedBackendObservation["devices"] =
      token === undefined
        ? { kind: "not-called" }
        : yield* backend.listDevices(backendUrl, token).pipe(
            Effect.as({ kind: "ok" } as const),
            Effect.catchTag("BackendUnauthorized", () => Effect.succeed({ kind: "unauthorized" as const })),
            Effect.catch((error) => Effect.succeed({ kind: "error" as const, message: error.message })),
            Effect.catchDefect((defect) => Effect.succeed({ kind: "error" as const, message: errorMessage(defect) }))
          );
    return { keychain, health, devices };
  });

/**
 * Diagnostics (plan 3.1, 3.13 rule 8). The flow only observes: it creates nothing and repairs nothing.
 * An invalid config stays a config error and does not add a "not paired" check, because the URL could not
 * be read. A readable config with no `backendUrl` adds one ok `sync` check. A paired config adds the
 * keychain, health, and devices checks. The command exits 0 whenever it completes; `healthy` is false when
 * any check is an error. A failing `stat` or mode read of the data directory is a defect.
 */
export const doctorFlow = Effect.gen(function* () {
  const platform = yield* SnorlaxPlatform;
  const nodeFiles = yield* NodeFiles;
  const info = yield* RuntimeInfo;
  const path = resolveDataDir(platform);
  const stat = yield* Effect.promise(() => platform.fs.stat(path));
  const observed: DataDirObservation =
    stat === undefined
      ? { path, kind: "missing", mode: undefined }
      : {
          path,
          kind: stat.kind === "dir" ? "dir" : stat.kind === "file" ? "file" : "other",
          mode: yield* Effect.promise(() => nodeFiles.mode(path))
        };
  // The config read is a check of its own: a config that does not parse and a read that throws both fail it.
  const configRead: ConfigRead = yield* readConfig(platform, path).pipe(
    Effect.map((value) => ({ ok: true as const, value })),
    Effect.catch((error) => Effect.succeed({ ok: false as const, message: error.message })),
    Effect.catchDefect((defect) => Effect.succeed({ ok: false as const, message: errorMessage(defect) }))
  );
  const config: ConfigObservation = configRead.ok ? { ok: true } : { ok: false, message: configRead.message };
  const job = yield* (yield* Scheduler).inspect;
  const nodePath = job.kind === "inspected" ? job.cliJob?.nodePath : undefined;
  const node = nodePath === undefined ? undefined : yield* nodeBinaryAt(platform, nodeFiles, nodePath);
  const sync = !configRead.ok
    ? []
    : configRead.value.backendUrl === undefined
      ? backendChecks({ paired: false })
      : backendChecks({
          paired: true,
          ...(yield* pairedObservation(platform, path, configRead.value.backendUrl))
        });
  const payload = doctorPayload([
    nodeVersionCheck(info.nodeVersion),
    dataDirCheck(observed),
    configCheck(config),
    scheduleCheck({ job, node }),
    ...sync
  ]);
  return { schemaVersion: 1, ok: true, healthy: payload.healthy, checks: payload.checks } satisfies Doctor;
});
