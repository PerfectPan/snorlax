import { appendFile, chmod, stat } from "node:fs/promises";

import type { Platform } from "@rivus/agent-kit/platform";
import { PlatformService } from "@rivus/agent-kit/platform/effect";
import { Context, Effect, Layer } from "effect";

/**
 * The agent-kit platform the collector runs on. The Node entrypoint derives it from the kit's `PlatformService`
 * (`NodePlatformLive`); tests provide the Node platform over a temporary home, or the kit's memory platform with
 * the process members it lacks filled in. `sqlite` is optional on the kit's interface: the Node platform has it,
 * and the ledger refuses to run without it.
 */
export class SnorlaxPlatform extends Context.Service<SnorlaxPlatform, Platform>()("snorlax/platform/SnorlaxPlatform") {
  /** The kit platform's Node implementation, as the collector sees it. */
  static readonly fromKitPlatform: Layer.Layer<SnorlaxPlatform, never, PlatformService> = Layer.effect(
    SnorlaxPlatform,
    Effect.gen(function* () {
      const platform = yield* PlatformService;
      return SnorlaxPlatform.of(platform);
    })
  );
}

/**
 * File operations the agent-kit `Platform` does not model: appending to the log file, and reading or setting
 * a directory's mode. The collector needs both for the 0700 data directory (plan 3.4.1) and the append-only
 * log (plan 3.9). Everything else goes through the kit platform.
 */
export interface NodeFileOps {
  /** Appends, creating the file when missing. */
  append(path: string, data: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  /** The path's permission bits, or undefined when nothing is at the path. */
  mode(path: string): Promise<number | undefined>;
}

export const nodeFileOps: NodeFileOps = {
  async append(path, data) {
    await appendFile(path, data, "utf8");
  },
  async chmod(path, mode) {
    await chmod(path, mode);
  },
  async mode(path) {
    try {
      return (await stat(path)).mode & 0o777;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }
};

/**
 * `NodeFileOps` as part of the environment, next to `SnorlaxPlatform`: `cli/bin.ts` provides the Node
 * implementation and tests a recording double, so no other code reaches for `node:fs` directly.
 */
export class NodeFiles extends Context.Service<NodeFiles, NodeFileOps>()("snorlax/platform/NodeFiles") {
  static readonly live: Layer.Layer<NodeFiles> = Layer.succeed(NodeFiles, nodeFileOps);
}
