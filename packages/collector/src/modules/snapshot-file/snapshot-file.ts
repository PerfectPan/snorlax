import { join } from "node:path";

import type { Platform } from "@rivus/agent-kit/platform";
import { snapshotSchema, type Snapshot } from "@rivus/snorlax-protocol";
import { Data } from "effect";
import * as z from "zod/mini";

import { errorMessage } from "../../core/error-message/error-message.ts";
import { readTextFile } from "../read-text-file/read-text-file.ts";

export type SnapshotRead =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "ok"; readonly snapshot: Snapshot };

/**
 * Reads `<data>/snapshot.json` and validates it with the protocol schema (plan 3.2.2). The snapshot is
 * rewritten atomically by refresh, so a torn read only ever appears as a missing file.
 */
export async function readSnapshotFile(platform: Pick<Platform, "fs">, dataDir: string): Promise<SnapshotRead> {
  const text = await readTextFile(platform, join(dataDir, "snapshot.json"));
  if (text === undefined) {
    return { kind: "missing" };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return { kind: "invalid", reason: errorMessage(error) };
  }
  const parsed = z.safeParse(snapshotSchema, json);
  if (!parsed.success) {
    return { kind: "invalid", reason: z.prettifyError(parsed.error) };
  }
  return { kind: "ok", snapshot: parsed.data };
}

/** `snapshot.json` could not be written; the previous snapshot stays in place. */
export class SnapshotWriteFailed extends Data.TaggedError("SnapshotWriteFailed")<{ readonly message: string }> {}

/**
 * Rewrites `<data>/snapshot.json` whole through the platform's atomic write (temp file plus rename, plan
 * 3.2.2), so a reader only ever sees the previous snapshot or the new one. A write failure leaves the
 * previous snapshot in place and fails with `SnapshotWriteFailed` (plan 6.8, Batch 2).
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
    throw new SnapshotWriteFailed({ message: `cannot write the snapshot ${path}: ${errorMessage(error)}` });
  }
}
