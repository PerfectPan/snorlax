import { Command } from "effect/cli";
import { Effect } from "effect";

import { Refresh } from "../refresh/service.ts";
import { CommandOutput } from "./output.ts";

const humanSummary = (scannedAt: string, records: number, failures: number): string =>
  [
    `scanned ${records} records at ${scannedAt}, ${failures} failures`,
    // Sync arrives with Batch 7; until then every refresh reports the device as not paired.
    "sync: not paired"
  ].join("\n");

/** `snorlax refresh` (plan 3.1, 3.4.1): scan, commit the ledger, write the snapshot. */
export const refreshCommand = Command.make("refresh", {}, () =>
  Effect.gen(function* () {
    const result = yield* (yield* Refresh).run;
    yield* (yield* CommandOutput).render({
      payload: result,
      human: `${humanSummary(result.scannedAt, result.records, result.failures)}\n`
    });
  })
).pipe(Command.withDescription("scan agent usage since the last run, update the ledger, write the snapshot"));
