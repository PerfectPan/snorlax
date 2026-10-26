import type { RefreshResult } from "@rivus/snorlax-protocol";
import { Flag } from "effect/cli";
import { Data, Effect } from "effect";

import { syncLine } from "../../core/sync-text/sync-text.ts";
import { rebuildFlow, REBUILD_MAX_DAYS, REBUILD_MIN_DAYS } from "./flow.ts";

/** `--days` parsed as a whole number outside `REBUILD_MIN_DAYS`–`REBUILD_MAX_DAYS`. */
class RebuildDaysOutOfRange extends Data.TaggedError("RebuildDaysOutOfRange")<{ readonly message: string }> {}

const humanSummary = (days: number, result: RefreshResult): string =>
  `rebuilt the last ${days} days: ${result.records} records, ${result.failures} failures\n${syncLine(result.sync)}\n`;

/** `snorlax rebuild --days <n>` (plan 3.1, 3.4.3): zero and rescan the last n days; 1 ≤ n ≤ 30. */
export const rebuildCommand = {
  name: "rebuild",
  description: "zero and rescan the last 1-30 days of local buckets",
  flags: {
    days: Flag.Int("days").pipe(
      Flag.withDescription(`whole number of days to rebuild (${REBUILD_MIN_DAYS}-${REBUILD_MAX_DAYS})`)
    )
  },
  run: ({ days }: { readonly days: number }) =>
    Effect.gen(function* () {
      if (days < REBUILD_MIN_DAYS || days > REBUILD_MAX_DAYS) {
        return yield* new RebuildDaysOutOfRange({
          message: `--days must be between ${REBUILD_MIN_DAYS} and ${REBUILD_MAX_DAYS}`
        });
      }
      const { result } = yield* rebuildFlow(days);
      return { payload: result, human: humanSummary(days, result) };
    })
};
