import type { UninstallResult } from "@rivus/snorlax-protocol";
import { Flag } from "effect/cli";
import { Effect } from "effect";

import { Scheduler, type SchedulerKind } from "../../capabilities/scheduler/scheduler.ts";
import { uninstallFlow } from "./flow.ts";

const humanResult = (
  deleteData: boolean,
  dataDir: string,
  dataLeftovers: readonly string[],
  kind: SchedulerKind,
  keychainNotice: string | undefined
): string => {
  const removed = kind === "systemd" ? "systemd user timer removed" : "LaunchAgent removed";
  const base =
    dataLeftovers.length > 0
      ? `${removed}\n` +
        `the data directory ${dataDir} is kept; entries snorlax did not write remain: ` +
        `${dataLeftovers.join(", ")}\n`
      : deleteData
        ? `${removed} and data directory deleted\n`
        : `${removed}\n`;
  return keychainNotice === undefined ? base : `${base}${keychainNotice}\n`;
};

/** Removes the scheduled refresh. `--data` also deletes the data directory and, from Batch 7, the keychain item. */
export const uninstallCommand = {
  name: "uninstall",
  description: "remove the scheduled refresh; --data deletes the data directory",
  flags: {
    data: Flag.Boolean("data").pipe(Flag.withDefault(false), Flag.withDescription("also delete the data directory"))
  },
  run: ({ data }: { readonly data: boolean }) =>
    Effect.gen(function* () {
      const { dataDir, deleted, dataLeftovers, keychainNotice } = yield* uninstallFlow({ deleteData: data });
      return {
        payload: {
          schemaVersion: 1,
          ok: true,
          ...(deleted ? { keptEntries: [...dataLeftovers] } : {})
        } satisfies UninstallResult,
        human: humanResult(data, dataDir, dataLeftovers, (yield* Scheduler).kind, keychainNotice),
        ...(deleted ? { deletedDataDir: true as const } : {})
      };
    })
};
