import { builtinProviders, type Provider } from "@rivus/agent-kit/providers";
import { detectAgents, type Installation } from "@rivus/agent-kit/discovery";
import { type DetectedAgent, type Status } from "@rivus/snorlax-protocol";

import { readConfig } from "../../config/config.ts";
import { readLedgerStatus } from "../../ledger/ledger.ts";
import { readSnapshotFile } from "../../snapshot/read.ts";
import { parseCommandArgs } from "../args.ts";
import type { Command, CommandOutcome } from "../command.ts";
import type { CliContext, CollectorPlatform } from "../context.ts";

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

export const statusCommand: Command = {
  id: "status",
  summary: "version, device, last scan and sync, decode failures, detected agents",
  async run(args, ctx: CliContext): Promise<CommandOutcome> {
    const { values } = parseCommandArgs(args, { json: { type: "boolean" } });

    const config = await readConfig(ctx.platform, ctx.dataDir);
    // Device id and last scan come from the ledger (plan 6.8, Batch 2); sync state and decode failures are
    // the last refresh's, persisted in the snapshot, until sync owns them in Batch 7.
    const ledger = await readLedgerStatus(ctx.platform, ctx.dataDir);
    const snapshot = await readSnapshotFile(ctx.platform, ctx.dataDir);
    const installations = await detectAgentsStatOnly(ctx.platform);

    const status = snapshot.kind === "ok" ? snapshot.snapshot.status : undefined;
    const payload: Status = {
      schemaVersion: 1,
      ok: true,
      version: ctx.version,
      dataDir: ctx.dataDir,
      device: { id: ledger?.deviceId ?? null, name: config.deviceName ?? null },
      lastScanAt:
        ledger?.lastScanCompletedAt === undefined || ledger.lastScanCompletedAt === null
          ? null
          : new Date(ledger.lastScanCompletedAt).toISOString(),
      sync: status?.sync ?? { state: "unpaired", at: null },
      failuresByAgent: status?.failuresByAgent ?? {},
      agents: installations.map(toDetected)
    };

    const human = [
      `snorlax ${payload.version}`,
      `data directory: ${payload.dataDir}`,
      `device: ${payload.device.name ?? "(unnamed)"} (${payload.device.id ?? "no id yet"})`,
      `last scan: ${payload.lastScanAt ?? "never"}`,
      `sync: ${payload.sync.state}${payload.sync.at === null ? "" : ` at ${payload.sync.at}`}`,
      `decode failures: ${
        Object.keys(payload.failuresByAgent).length === 0
          ? "none"
          : Object.entries(payload.failuresByAgent)
              .map(([agent, count]) => `${agent}=${count}`)
              .join(" ")
      }`,
      `agents: ${payload.agents.map((agent) => `${agent.agent}=${agent.status}`).join(" ")}`
    ].join("\n");

    return { json: values.json === true, payload, human: `${human}\n` };
  }
};
