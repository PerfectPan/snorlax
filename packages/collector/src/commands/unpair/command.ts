import type { Ok } from "@rivus/snorlax-protocol";
import { Effect } from "effect";

import { unpairFlow } from "./flow.ts";

const HUMAN =
  "local data is kept\n" +
  "if this device was registered, the backend still lists it until it is revoked with the admin token\n";

/** `snorlax unpair` (plan 3.1): drop the local pairing. The backend keeps the device until an admin revoke. */
export const unpairCommand = {
  name: "unpair",
  description: "remove the local pairing; the backend device stays until it is revoked",
  flags: {},
  run: () =>
    Effect.map(unpairFlow, (notice) => ({
      payload: { schemaVersion: 1, ok: true } satisfies Ok,
      human: notice === undefined ? HUMAN : `${HUMAN}${notice}\n`
    }))
};
