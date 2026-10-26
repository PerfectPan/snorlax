import type { UninstallResult } from "@rivus/snorlax-protocol";
import { Flag } from "effect/cli";
import { Effect } from "effect";

import { uninstallFlow } from "./flow.ts";

const humanResult = (
  deleteData: boolean,
  dataDir: string,
  dataLeftovers: readonly string[],
  os: "darwin" | "linux" | "win32" | undefined
): string => {
  const removed = os === "linux" ? "systemd user timer removed" : "LaunchAgent removed";
  if (dataLeftovers.length > 0) {
    return (
      `${removed}\n` +
      `the data directory ${dataDir} is kept; entries snorlax did not write remain: ` +
      `${dataLeftovers.join(", ")}\n`
    );
  }
  return deleteData ? `${removed} and data directory deleted\n` : `${removed}\n`;
};

/** Removes the scheduled refresh. `--data` also deletes the data directory and, from Batch 7, the keychain item. */
export const uninstallCommand = {
  name: "uninstall",
  description: "remove the scheduled refresh; --data deletes the data directory",
  flags: {
    data: Flag.Boolean("data").pipe(Flag.withDefault(false), Flag.withDescription("also delete the data directory"))
  },
  run: ({ data }: { readonly data: boolean }) =>
    Effect.map(uninstallFlow({ deleteData: data }), ({ dataDir, deleted, dataLeftovers, os }) => ({
      payload: {
        schemaVersion: 1,
        ok: true,
        ...(deleted ? { keptEntries: [...dataLeftovers] } : {})
      } satisfies UninstallResult,
      human: humanResult(data, dataDir, dataLeftovers, os),
      ...(deleted ? { deletedDataDir: true as const } : {})
    }))
};
