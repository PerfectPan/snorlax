import { Flag } from "effect/cli";
import { Effect } from "effect";

import { uninstallFlow } from "./flow.ts";

const humanResult = (deleteData: boolean, dataDir: string, dataLeftovers: readonly string[]): string => {
  if (dataLeftovers.length > 0) {
    return (
      `LaunchAgent removed\n` +
      `the data directory ${dataDir} is kept; entries snorlax did not write remain: ` +
      `${dataLeftovers.join(", ")}\n`
    );
  }
  return deleteData ? "LaunchAgent removed and data directory deleted\n" : "LaunchAgent removed\n";
};

/** Removes the LaunchAgent. `--data` also deletes the data directory and, from Batch 7, the keychain item. */
export const uninstallCommand = {
  name: "uninstall",
  description: "remove the LaunchAgent; --data deletes the data directory",
  flags: {
    data: Flag.Boolean("data").pipe(Flag.withDefault(false), Flag.withDescription("also delete the data directory"))
  },
  run: ({ data }: { readonly data: boolean }) =>
    Effect.map(uninstallFlow({ deleteData: data }), ({ dataDir, deleted, dataLeftovers }) => ({
      payload: { schemaVersion: 1, ok: true },
      human: humanResult(data, dataDir, dataLeftovers),
      ...(deleted ? { deletedDataDir: true as const } : {})
    }))
};
