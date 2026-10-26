import { builtinProviders, type Provider } from "@rivus/agent-kit/providers";
import { detectAgents, type Installation } from "@rivus/agent-kit/discovery";
import type { Platform } from "@rivus/agent-kit/platform";
import type { DetectedAgent, Status } from "@rivus/snorlax-protocol";
import { Data, Effect } from "effect";

import { errorMessage } from "../../core/error-message/error-message.ts";
import { readConfig } from "../../modules/config/config.ts";
import { resolveDataDir } from "../../modules/data-dir/data-dir.ts";
import { readLedgerStatus } from "../../modules/ledger/ledger.ts";
import { SnorlaxPlatform } from "../../modules/platform/platform.ts";
import { readSnapshotFile } from "../../modules/snapshot-file/snapshot-file.ts";
import { RuntimeInfo } from "../../modules/version/version.ts";

/**
 * Detects the builtin agents without side effects (plan 3.10): the version probe stays off and the recipes'
 * auth probes are stripped, so no agent command runs and no credential file is read — detection only stats
 * paths. `runnable` therefore never appears.
 */
function detectAgentsStatOnly(platform: Platform): Promise<Installation[]> {
  const providers: Provider[] = builtinProviders.flatMap((provider) =>
    provider.discovery === undefined
      ? []
      : [{ id: provider.id, discovery: { ...provider.discovery, version: undefined, auth: undefined } }]
  );
  return detectAgents(platform, { providers, versionProbe: false });
}

const toDetected = (installation: Installation): DetectedAgent => ({
  agent: installation.agent,
  displayName: installation.displayName,
  status: installation.status
});

/** A read behind the `status` payload failed outside what the config and ledger modules report (I/O, detection). */
class StatusReadFailed extends Data.TaggedError("StatusReadFailed")<{ readonly message: string }> {}

/**
 * Assembles the `status` payload (plan 3.1) from reads alone: config, ledger meta (opened read-only,
 * and only when the ledger file exists), the stored snapshot and stat-only agent detection. A missing
 * ledger or snapshot leaves the fields null; a corrupt config or ledger fails the command, and so does
 * any other read that fails. Nothing is created or written (plan 3.13).
 */
export const statusFlow = Effect.gen(function* () {
  const platform = yield* SnorlaxPlatform;
  const info = yield* RuntimeInfo;
  const dataDir = resolveDataDir(platform);
  const config = yield* readConfig(platform, dataDir);
  // Device id and last scan come from the ledger (plan 6.8, Batch 2). Sync state and decode
  // failures are the last refresh's, persisted in the snapshot.
  const ledger = yield* readLedgerStatus(platform, dataDir);
  const snapshot = yield* Effect.promise(() => readSnapshotFile(platform, dataDir));
  const installations = yield* Effect.promise(() => detectAgentsStatOnly(platform));

  const status = snapshot.kind === "ok" ? snapshot.snapshot.status : undefined;
  return {
    schemaVersion: 1,
    ok: true,
    version: info.version,
    dataDir,
    device: { id: ledger?.deviceId ?? null, name: config.deviceName ?? null },
    lastScanAt:
      ledger?.lastScanCompletedAt === undefined || ledger.lastScanCompletedAt === null
        ? null
        : new Date(ledger.lastScanCompletedAt).toISOString(),
    sync: status?.sync ?? { state: "unpaired", at: null },
    failuresByAgent: status?.failuresByAgent ?? {},
    pricingChanged: ledger?.pricingChanged ?? false,
    agents: installations.map(toDetected)
  } satisfies Status;
}).pipe(
  // Config and ledger report a corrupt file as their own failures; a read that throws for any other reason
  // (file I/O, agent detection) still fails the command with the data-dir code, not as a defect.
  Effect.catchDefect((defect) => Effect.fail(new StatusReadFailed({ message: errorMessage(defect) })))
);
