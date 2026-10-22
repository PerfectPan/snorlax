import { join } from "node:path";

import type { Platform } from "@rivus/agent-kit/platform";
import type { Snapshot } from "@rivus/snorlax-protocol";

/**
 * Rewrites `<data>/snapshot.json` whole through the platform's atomic write (temp file plus rename, plan
 * 3.2.2), so a reader only ever sees the previous snapshot or the new one.
 */
export async function writeSnapshot(
  platform: Pick<Platform, "fs">,
  dataDir: string,
  snapshot: Snapshot
): Promise<void> {
  await platform.fs.writeAtomic(join(dataDir, "snapshot.json"), `${JSON.stringify(snapshot)}\n`);
}
