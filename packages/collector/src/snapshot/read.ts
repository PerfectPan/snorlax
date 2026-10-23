import { join } from "node:path";

import type { Platform } from "@rivus/agent-kit/platform";
import { snapshotSchema, type Snapshot } from "@rivus/snorlax-protocol";
import * as z from "zod/mini";

import { errorMessage } from "../util/error-message.ts";
import { readTextFile } from "../util/read-text-file.ts";

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
