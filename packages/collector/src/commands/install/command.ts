import { Command } from "effect/cli";
import { Effect } from "effect";

import { Schedule } from "../../capabilities/scheduler/scheduler.ts";
import { JsonFlag } from "../flags.ts";
import { CommandOutput } from "../output.ts";

/** Registers `~/Library/LaunchAgents/io.github.perfectpan.snorlax.refresh.plist` and loads it. */
export const installCommand = Command.make("install", {}, () =>
  Effect.gen(function* () {
    const json = yield* JsonFlag;
    const plistPath = yield* (yield* Schedule).install;
    yield* (yield* CommandOutput).render({
      payload: { schemaVersion: 1, ok: true },
      human: `LaunchAgent installed at ${plistPath}\n`,
      json
    });
  })
).pipe(Command.withDescription("register the macOS LaunchAgent for refresh"));
