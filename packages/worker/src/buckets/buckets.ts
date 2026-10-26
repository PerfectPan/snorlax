import type { Bucket } from "@rivus/snorlax-protocol";

import type { D1Database } from "../db.ts";
import { readBucketsAfter, writePush } from "./store.ts";

/**
 * Bucket use cases (plan 3.2.4, 3.5): a device pushes absolute rows for itself only, and any device pulls
 * every device's rows after a cursor. They take parsed values and throw the error below, which says what
 * went wrong and knows no HTTP status.
 */

/** A push to another device's path, or a row naming another device (Spec S9). */
class ForeignDeviceWrite extends Error {
  readonly _tag = "ForeignDeviceWrite";
}

/** Every error these use cases throw; `http/failures.ts` gives each tag its answer. */
export const bucketsErrors = [ForeignDeviceWrite] as const;

interface BucketsDeps {
  readonly db: D1Database;
  /** Epoch milliseconds. */
  readonly now: () => number;
}

interface Push {
  /** The authenticated device. */
  readonly deviceId: string;
  /** The device the request path names. */
  readonly pathDeviceId: string;
  readonly buckets: readonly Bucket[];
}

/**
 * Writes a device's own rows and returns the highest seq written. A path or row naming any other device is
 * `ForeignDeviceWrite` and writes nothing. The rows are one batch, so the answer is the batch's base seq plus
 * the row count.
 */
export const pushBuckets = async ({ db, now }: BucketsDeps, push: Push): Promise<number> => {
  if (push.pathDeviceId !== push.deviceId) {
    throw new ForeignDeviceWrite("a device token may only write its own device's path");
  }
  if (push.buckets.some((bucket) => bucket.deviceId !== push.deviceId)) {
    throw new ForeignDeviceWrite("every bucket's deviceId must equal the path's device id");
  }
  const base = await writePush(db, push.deviceId, push.buckets, now());
  return base + push.buckets.length;
};

interface Page {
  readonly buckets: Bucket[];
  /** The last returned row's seq, or null when the page is empty. */
  readonly next: number | null;
}

export const pullBuckets = async (
  db: D1Database,
  cursor: { readonly after: number; readonly limit: number }
): Promise<Page> => {
  const rows = await readBucketsAfter(db, cursor.after, cursor.limit);
  const last = rows.at(-1);
  return {
    buckets: rows.map(({ seq, ...bucket }) => {
      void seq;
      return bucket;
    }),
    next: last === undefined ? null : last.seq
  };
};
