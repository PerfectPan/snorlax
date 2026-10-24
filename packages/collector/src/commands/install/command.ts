import { Effect } from "effect";

import { Schedule } from "../../capabilities/scheduler/scheduler.ts";

/** Registers `~/Library/LaunchAgents/io.github.perfectpan.snorlax.refresh.plist` and loads it. */
export const installCommand = {
  name: "install",
  description: "register the macOS LaunchAgent for refresh",
  flags: {},
  run: () =>
    Effect.gen(function* () {
      const plistPath = yield* (yield* Schedule).install;
      return { payload: { schemaVersion: 1, ok: true }, human: `LaunchAgent installed at ${plistPath}\n` };
    })
};
