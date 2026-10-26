import { Effect } from "effect";

import { Scheduler, type SchedulerKind } from "../../capabilities/scheduler/scheduler.ts";
import { installFlow } from "./flow.ts";

const installed = (kind: SchedulerKind, jobFile: string): string =>
  `${kind === "systemd" ? "systemd user timer" : "LaunchAgent"} installed at ${jobFile}\n`;

/** Registers the refresh job the scheduler manages and loads it. */
export const installCommand = {
  name: "install",
  description: "register the scheduled refresh (LaunchAgent, or a systemd user timer on Linux)",
  flags: {},
  run: () =>
    Effect.gen(function* () {
      const jobFile = yield* installFlow;
      return {
        payload: { schemaVersion: 1, ok: true },
        human: installed((yield* Scheduler).kind, jobFile)
      };
    })
};
