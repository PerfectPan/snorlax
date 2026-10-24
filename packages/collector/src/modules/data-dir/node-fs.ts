import { appendFile, chmod, stat } from "node:fs/promises";

import { Context, Layer } from "effect";

/**
 * File operations the agent-kit `Platform` does not model: appending to the log file, and reading or setting
 * a directory's mode. The collector needs both for the 0700 data directory (plan 3.4.1) and the append-only
 * log (plan 3.9). Everything else goes through the kit platform; tests substitute this service.
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

/** The `NodeFileOps` implementation as a service, so feature modules never reach for `node:fs` directly. */
export class NodeFiles extends Context.Service<NodeFiles, NodeFileOps>()("snorlax/data-dir/NodeFiles") {
  /** The real Node implementation; tests provide a recording double instead. */
  static readonly live: Layer.Layer<NodeFiles> = Layer.succeed(NodeFiles, nodeFileOps);
}
