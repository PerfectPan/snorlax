import { Command, Flag } from "effect/cli";
import { Effect } from "effect";

import { Rebuild } from "../rebuild/service.ts";
import { REBUILD_MAX_DAYS, REBUILD_MIN_DAYS } from "../rebuild/rebuild.ts";
import { UsageError } from "../errors.ts";
import { JsonFlag } from "./flags.ts";
import { CommandOutput } from "./output.ts";

const humanSummary = (days: number, records: number, failures: number): string =>
  `rebuilt the last ${days} days: ${records} records, ${failures} failures\nsync: not paired\n`;

/** `snorlax rebuild --days <n>` (plan 3.1, 3.4.3): zero and rescan the last n days; 1 ≤ n ≤ 30. */
export const rebuildCommand = Command.make(
  "rebuild",
  {
    days: Flag.Int("days").pipe(
      Flag.withDescription(`whole number of days to rebuild (${REBUILD_MIN_DAYS}-${REBUILD_MAX_DAYS})`)
    )
  },
  ({ days }) =>
    Effect.gen(function* () {
      const json = yield* JsonFlag;
      if (days < REBUILD_MIN_DAYS || days > REBUILD_MAX_DAYS) {
        return yield* new UsageError({ message: `--days must be between ${REBUILD_MIN_DAYS} and ${REBUILD_MAX_DAYS}` });
      }
      const result = yield* (yield* Rebuild).run(days);
      yield* (yield* CommandOutput).render({
        payload: result,
        human: humanSummary(days, result.records, result.failures),
        json
      });
    })
).pipe(Command.withDescription("zero and rescan the last 1-30 days of local buckets"));
