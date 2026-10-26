import type { PairResult } from "@rivus/snorlax-protocol";
import { Flag } from "effect/cli";
import { Effect } from "effect";

import { syncLine } from "../../core/sync-text/sync-text.ts";
import { REREGISTERED, pairFlow } from "./flow.ts";

/**
 * `snorlax pair --url <url> --name <name>` (plan 3.1, 3.4.2). The admin token is read from stdin. JSON output
 * is `PairResult`; the refresh that follows is in the human text and the log.
 */
export const pairCommand = {
  name: "pair",
  description: "register this device with a backend and store its device token",
  flags: {
    url: Flag.String("url").pipe(
      Flag.withDescription("backend URL (https, or http on localhost, 127.0.0.1, or [::1])")
    ),
    name: Flag.String("name").pipe(Flag.withDescription("name shown for this device"))
  },
  run: ({ url, name }: { readonly url: string; readonly name: string }) =>
    Effect.gen(function* () {
      const paired = yield* pairFlow({ url, name });
      const payload = {
        schemaVersion: 1,
        ok: true,
        deviceId: paired.deviceId,
        name: paired.name
      } satisfies PairResult;
      // A refresh that never produced a report still leaves the pairing in place. The next scheduled run retries.
      const detail =
        "sync" in paired
          ? syncLine(paired.sync)
          : `refresh did not finish (${paired.refreshNote}). The next scheduled refresh will catch up.`;
      const replaced = paired.reregistered ? `${REREGISTERED}\n` : "";
      return {
        payload,
        human: `paired ${paired.name} (${paired.deviceId})\n${replaced}${detail}\n`
      };
    })
};
