import { Effect } from "effect";

import { installFlow } from "./flow.ts";

/** Registers `~/Library/LaunchAgents/io.github.perfectpan.snorlax.refresh.plist` and loads it. */
export const installCommand = {
  name: "install",
  description: "register the macOS LaunchAgent for refresh",
  flags: {},
  run: () =>
    Effect.map(installFlow, (jobFile) => ({
      payload: { schemaVersion: 1, ok: true },
      human: `LaunchAgent installed at ${jobFile}\n`
    }))
};
