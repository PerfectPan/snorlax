import { Effect } from "effect";

import { installFlow } from "./flow.ts";

/** Registers the LaunchAgent, or on Linux the systemd user timer, and loads it. */
export const installCommand = {
  name: "install",
  description: "register the scheduled refresh (LaunchAgent, or a systemd user timer on Linux)",
  flags: {},
  run: () =>
    Effect.map(installFlow, (jobFile) => ({
      payload: { schemaVersion: 1, ok: true },
      human: jobFile.endsWith(".timer")
        ? `systemd user timer installed at ${jobFile}\n`
        : `LaunchAgent installed at ${jobFile}\n`
    }))
};
