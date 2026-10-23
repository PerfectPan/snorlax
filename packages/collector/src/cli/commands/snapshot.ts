import type { Snapshot } from "@rivus/snorlax-protocol";

import { readSnapshotFile } from "../../snapshot/read.ts";
import { CliError } from "../errors.ts";
import { parseCommandArgs } from "../args.ts";
import type { Command, CommandOutcome } from "../command.ts";
import type { CliContext } from "../context.ts";

const humanSummary = (snapshot: Snapshot): string => {
  const { totals } = snapshot;
  const window = (label: string, total: Snapshot["totals"]["today"]): string =>
    `${label}: ${total.tokens} tokens, $${total.costUsd.toFixed(2)}, ${total.requests} requests, ${total.sessions} sessions`;
  const topAgents = [...snapshot.byAgent]
    .sort((a, b) => b.today.tokens - a.today.tokens)
    .slice(0, 3)
    .map((agent) => `${agent.agent}=${agent.today.tokens}`)
    .join(" ");
  return [
    `generated at ${snapshot.generatedAt} (${snapshot.timeZone})`,
    window("today", totals.today),
    window("last 7 days", totals.last7d),
    window("last 30 days", totals.last30d),
    `top agents today: ${topAgents === "" ? "none" : topAgents}`
  ].join("\n");
};

/** Prints the current snapshot; it is written by `refresh`, so a fresh data directory has none yet. */
export const snapshotCommand: Command = {
  id: "snapshot",
  summary: "print the current snapshot",
  async run(args, ctx: CliContext): Promise<CommandOutcome> {
    const { values } = parseCommandArgs(args, { json: { type: "boolean" } });

    const read = await readSnapshotFile(ctx.platform, ctx.dataDir);
    if (read.kind === "missing") {
      throw new CliError("data-dir", `no snapshot exists yet in ${ctx.dataDir}; snorlax refresh writes it`);
    }
    if (read.kind === "invalid") {
      throw new CliError("data-dir", `snapshot.json in ${ctx.dataDir} is not a valid snapshot: ${read.reason}`);
    }
    return {
      json: values.json === true,
      payload: read.snapshot,
      human: `${humanSummary(read.snapshot)}\n`
    };
  }
};
