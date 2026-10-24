import { join } from "node:path";

import type { Platform } from "@rivus/agent-kit/platform";
import type { Snapshot } from "@rivus/snorlax-protocol";

import { CommandError } from "../errors.ts";
import { errorMessage } from "../util/error-message.ts";

/**
 * Rewrites `<data>/snapshot.json` whole through the platform's atomic write (temp file plus rename, plan
 * 3.2.2), so a reader only ever sees the previous snapshot or the new one. A write failure leaves the
 * previous snapshot in place and fails the command as `data-dir` (plan 6.8, Batch 2).
 */
export async function writeSnapshot(
  platform: Pick<Platform, "fs">,
  dataDir: string,
  snapshot: Snapshot
): Promise<void> {
  const path = join(dataDir, "snapshot.json");
  try {
    await platform.fs.writeAtomic(path, `${JSON.stringify(snapshot)}\n`);
  } catch (error) {
    throw new CommandError({ code: "data-dir", message: `cannot write the snapshot ${path}: ${errorMessage(error)}` });
  }
}
