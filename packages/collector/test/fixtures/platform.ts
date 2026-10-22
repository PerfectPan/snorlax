import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNodePlatform } from "@rivus/agent-kit/node";
import type { Platform } from "@rivus/agent-kit/platform";

import type { RefreshPlatform } from "../../src/refresh/lock.ts";

/**
 * A refresh test bed: a real temporary home (generated fixtures only — a real agent home is never read),
 * the Node platform with its clock replaced by a fixed one, and a byte counter on every file read, which
 * proves a later refresh decodes no unchanged source again (Spec S2).
 */
export interface RefreshSetup {
  readonly home: string;
  readonly dataDir: string;
  readonly platform: RefreshPlatform;
  readonly readBytes: Map<string, number>;
  readonly remove: () => Promise<void>;
}

export interface SetupOptions {
  /** The fixed wall clock every refresh runs at, epoch milliseconds. */
  readonly now: number;
}

export async function createRefreshSetup(options: SetupOptions): Promise<RefreshSetup> {
  const home = await mkdtemp(join(tmpdir(), "snorlax-refresh-"));
  const dataDir = join(home, "data");
  // The CLI's context creates the data directory (plan 3.4.1 step 1); these tests call the use case
  // directly, so the setup stands in for that step.
  await mkdir(dataDir, { recursive: true });
  const base = createNodePlatform({
    home,
    env: {
      PATH: "/usr/bin:/bin",
      XDG_DATA_HOME: join(home, ".local", "share")
    }
  });
  const readBytes = new Map<string, number>();
  const countReads = (path: string, range?: Parameters<Platform["fs"]["read"]>[1]) => {
    const chunks = base.fs.read(path, range);
    return {
      [Symbol.asyncIterator]() {
        return (async function* () {
          for await (const chunk of chunks) {
            readBytes.set(path, (readBytes.get(path) ?? 0) + chunk.byteLength);
            yield chunk;
          }
        })();
      }
    };
  };
  const { sqlite } = base;
  if (sqlite === undefined) {
    throw new Error("the agent-kit Node platform must provide SQLite");
  }
  const platform: RefreshPlatform = {
    env: base.env,
    home: base.home,
    os: base.os,
    sqlite,
    fs: { ...base.fs, read: countReads },
    process: base.process,
    clock: { now: () => options.now, monotonic: () => 0 }
  };
  return {
    home,
    dataDir,
    platform,
    readBytes,
    remove: () => rm(home, { recursive: true, force: true })
  };
}
