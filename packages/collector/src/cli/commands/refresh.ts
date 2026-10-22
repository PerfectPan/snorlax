import type { Platform } from "@rivus/agent-kit/platform";

import { runRefresh } from "../../refresh/refresh.ts";
import type { RefreshPlatform } from "../../refresh/lock.ts";
import type { CollectorPlatform } from "../context.ts";
import { CliError } from "../errors.ts";
import { parseCommandArgs } from "../args.ts";
import type { Command, CommandOutcome } from "../command.ts";
import type { CliContext } from "../context.ts";

/**
 * Widens the context's platform into what a refresh runs on. SQLite is required (the ledger); the process
 * identity members are read by the ledger lock inside the kit's own try/catch, so a platform without them
 * gets members that throw — on the Node platform none of the fallbacks are used.
 */
export function refreshPlatformOf(platform: CollectorPlatform): RefreshPlatform {
  if (platform.sqlite === undefined) {
    throw new CliError("internal", "this platform has no SQLite; the ledger cannot run here");
  }
  const unavailable = (member: keyof Platform["process"]) => (): never => {
    throw new CliError("internal", `this platform has no process.${member}; the ledger lock cannot run here`);
  };
  const identityOf = platform.process;
  return {
    env: platform.env,
    home: platform.home,
    os: platform.os,
    fs: platform.fs,
    clock: platform.clock,
    sqlite: platform.sqlite,
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

const humanSummary = (scannedAt: string, records: number, failures: number): string =>
  [
    `scanned ${records} records at ${scannedAt}, ${failures} failures`,
    // Sync arrives with Batch 7; until then every refresh reports the device as not paired.
    "sync: not paired"
  ].join("\n");

/** `snorlax refresh` (plan 3.1, 3.4.1): scan, commit the ledger, write the snapshot. */
export const refreshCommand: Command = {
  id: "refresh",
  summary: "scan agent usage since the last run, update the ledger, write the snapshot",
  async run(args, ctx: CliContext): Promise<CommandOutcome> {
    const { values } = parseCommandArgs(args, { json: { type: "boolean" } });
    const { result } = await runRefresh({
      platform: refreshPlatformOf(ctx.platform),
      dataDir: ctx.dataDir,
      log: ctx.log,
      timeZone: ctx.timeZone
    });
    return {
      json: values.json === true,
      payload: result,
      human: `${humanSummary(result.scannedAt, result.records, result.failures)}\n`
    };
  }
};
