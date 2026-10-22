import { runRebuild, REBUILD_MAX_DAYS, REBUILD_MIN_DAYS } from "../../rebuild/rebuild.ts";
import { parseCommandArgs } from "../args.ts";
import type { Command, CommandOutcome } from "../command.ts";
import type { CliContext } from "../context.ts";
import { UsageError } from "../errors.ts";
import { refreshPlatformOf } from "./refresh.ts";

const parseDays = (raw: string | undefined): number => {
  if (raw === undefined || !/^\d+$/.test(raw)) {
    throw new UsageError(`--days needs a whole number of days (${REBUILD_MIN_DAYS}-${REBUILD_MAX_DAYS})`);
  }
  const days = Number(raw);
  if (days < REBUILD_MIN_DAYS || days > REBUILD_MAX_DAYS) {
    throw new UsageError(`--days must be between ${REBUILD_MIN_DAYS} and ${REBUILD_MAX_DAYS}`);
  }
  return days;
};

/** `snorlax rebuild --days <n>` (plan 3.1, 3.4.3): zero and rescan the last n days; 1 ≤ n ≤ 30. */
export const rebuildCommand: Command = {
  id: "rebuild",
  summary: "zero and rescan the last 1-30 days of local buckets",
  async run(args, ctx: CliContext): Promise<CommandOutcome> {
    const { values } = parseCommandArgs(args, { json: { type: "boolean" }, days: { type: "string" } });
    const days = parseDays(values.days);
    const { result } = await runRebuild(
      { platform: refreshPlatformOf(ctx.platform), dataDir: ctx.dataDir, log: ctx.log, timeZone: ctx.timeZone },
      days
    );
    return {
      json: values.json === true,
      payload: result,
      human: `rebuilt the last ${days} days: ${result.records} records, ${result.failures} failures\nsync: not paired\n`
    };
  }
};
