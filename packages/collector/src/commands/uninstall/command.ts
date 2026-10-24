import { Flag } from "effect/cli";
import { Effect } from "effect";

import { DataDir } from "../../modules/data-dir/data-dir.ts";
import { Schedule } from "../../capabilities/scheduler/scheduler.ts";

/**
 * Removes the LaunchAgent. `--data` also deletes the data directory. The keychain item is removed
 * from the same path once Batch 7 fills in `removeKeychainItem`.
 */
export const uninstallCommand = {
  name: "uninstall",
  description: "remove the LaunchAgent; --data deletes the data directory",
  flags: {
    data: Flag.Boolean("data").pipe(Flag.withDefault(false), Flag.withDescription("also delete the data directory"))
  },
  run: ({ data }: { readonly data: boolean }) =>
    Effect.gen(function* () {
      const dataDir = yield* DataDir;
      const { dataLeftovers } = yield* (yield* Schedule).uninstall({ deleteData: data });
      let human = data ? "LaunchAgent removed and data directory deleted\n" : "LaunchAgent removed\n";
      if (dataLeftovers.length > 0) {
        human =
          `LaunchAgent removed\n` +
          `the data directory ${dataDir.path} is kept; entries snorlax did not write remain: ` +
          `${dataLeftovers.join(", ")}\n`;
      }
      return { payload: { schemaVersion: 1, ok: true }, human };
    })
};
