import { builtinProviders, type Provider } from "@rivus/agent-kit/providers";
import { detectAgents, type Installation } from "@rivus/agent-kit/discovery";
import type { CollectorPlatform } from "../../modules/platform/platform.ts";
import { SnorlaxPlatform } from "../../modules/platform/platform.ts";
import type { DetectedAgent, Status } from "@rivus/snorlax-protocol";
import { Context, Effect, Layer } from "effect";

import { readConfig } from "../../modules/config/config.ts";
import { DataDir } from "../../modules/data-dir/data-dir.ts";
import { CommandError } from "../../modules/errors/errors.ts";
import { readLedgerStatus } from "../../modules/ledger/ledger.ts";
import { RuntimeInfo } from "../../modules/version/version.ts";
import { readSnapshotFile } from "../../modules/snapshot-file/snapshot-file.ts";
import { errorMessage } from "../../core/error-message/error-message.ts";

/**
 * Detects the builtin agents without side effects (plan 3.10): the version probe stays off and the recipes'
 * auth probes are stripped, so no agent command runs and no credential file is read — detection only stats
 * paths. `runnable` therefore never appears.
 */
export async function detectAgentsStatOnly(platform: CollectorPlatform): Promise<Installation[]> {
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

/**
 * Assembles the `status` payload (plan 3.1) from reads alone: config, ledger meta (opened read-only,
 * and only when the ledger file exists), the stored snapshot and stat-only agent detection. A missing
 * ledger or snapshot leaves the fields null; a corrupt config or ledger is a `data-dir` failure.
 * Nothing is created or written (plan 3.13).
 */
export class StatusReport extends Context.Service<
  StatusReport,
  {
    readonly report: Effect.Effect<Status, CommandError>;
  }
>()("snorlax/status/StatusReport") {
  static readonly live = Layer.effect(
    StatusReport,
    Effect.gen(function* () {
      const platform = yield* SnorlaxPlatform;
      const dataDir = yield* DataDir;
      const info = yield* RuntimeInfo;
      return StatusReport.of({
        report: Effect.tryPromise({
          try: async () => {
            const config = await readConfig(platform, dataDir.path);
            // Device id and last scan come from the ledger (plan 6.8, Batch 2); sync state and decode
            // failures are the last refresh's, persisted in the snapshot, until sync owns them in Batch 7.
            const ledger = await readLedgerStatus(platform, dataDir.path);
            const snapshot = await readSnapshotFile(platform, dataDir.path);
            const installations = await detectAgentsStatOnly(platform);

            const status = snapshot.kind === "ok" ? snapshot.snapshot.status : undefined;
            return {
              schemaVersion: 1,
              ok: true,
              version: info.version,
              dataDir: dataDir.path,
              device: { id: ledger?.deviceId ?? null, name: config.deviceName ?? null },
              lastScanAt:
                ledger?.lastScanCompletedAt === undefined || ledger.lastScanCompletedAt === null
                  ? null
                  : new Date(ledger.lastScanCompletedAt).toISOString(),
              sync: status?.sync ?? { state: "unpaired", at: null },
              failuresByAgent: status?.failuresByAgent ?? {},
              agents: installations.map(toDetected)
            } satisfies Status;
          },
          catch: (error) =>
            error instanceof CommandError ? error : new CommandError({ code: "data-dir", message: errorMessage(error) })
        })
      });
    })
  );
}
