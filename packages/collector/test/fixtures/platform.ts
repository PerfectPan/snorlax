import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNodePlatform } from "@rivus/agent-kit/node";
import type { Platform } from "@rivus/agent-kit/platform";
import type { createMemoryPlatform } from "@rivus/agent-kit/testing";

/** The Node platform of a test bed: SQLite is always there, so tests open the ledger and its lock directly. */
export type TestPlatform = Platform & { readonly sqlite: NonNullable<Platform["sqlite"]> };

/**
 * A refresh test bed: a real temporary home (generated fixtures only — a real agent home is never read),
 * the Node platform with its clock replaced by a fixed one, and a byte counter on every file read, which
 * proves a later refresh decodes no unchanged source again (Spec S2).
 */
export interface RefreshSetup {
  readonly home: string;
  readonly dataDir: string;
  readonly platform: TestPlatform;
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
  // The CLI's flows create the data directory (plan 3.4.1 step 1); the test runs of the flows prepare
  // nothing (test/fixtures/flows.ts), so the setup stands in for that step.
  await mkdir(dataDir, { recursive: true });
  const base = createNodePlatform({
    home,
    env: {
      PATH: "/usr/bin:/bin",
      XDG_DATA_HOME: join(home, ".local", "share"),
      // A test that forgets its own stub still must not start the real store tools.
      SNORLAX_SECURITY: join(home, "no-security"),
      SNORLAX_SECRET_TOOL: join(home, "no-secret-tool")
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
  const platform: TestPlatform = {
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

const missingOnMemory = (member: string): Error => new Error(`the memory platform has no process.${member}`);

/**
 * The kit's memory platform as the full kit `Platform` the collector runs on. The memory platform runs scripted
 * commands only; the process members it lacks (spawning and process identity, which no command run on it
 * uses) throw. `run`, when given, replaces the scripted commands: the memory platform's own `run` rejects an
 * aborted run at once, so a program that outlives the abort, as a real child does, needs its own.
 */
export function memoryKitPlatform(
  memory: ReturnType<typeof createMemoryPlatform>,
  run: Platform["process"]["run"] = (command, args, options) => memory.process.run(command, args, options)
): Platform {
  return {
    env: memory.env,
    home: memory.home,
    os: memory.os,
    fs: memory.fs,
    clock: memory.clock,
    process: {
      run,
      spawn: () => {
        throw missingOnMemory("spawn");
      },
      identify: () => {
        throw missingOnMemory("identify");
      },
      get self(): never {
        throw missingOnMemory("self");
      }
    }
  };
}
