import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  launcherPath,
  NODE_PATH_FILE,
  renderNodePathSeed,
  renderRefreshLauncher
} from "../src/capabilities/scheduler/launcher.ts";

/**
 * The launcher script runs under the real `/bin/sh` over a temporary data directory: `node-path` wins
 * over the fallbacks, its first line is the Node, and the CLI runs with `refresh`. The stub Node is a
 * trampoline (`exec "$@"`), so the "collector" it starts is another stub whose output the test reads —
 * an assertion that the stub answered proves node-path was preferred, on every machine that has a
 * fallback Node and on the ones that have none. The fallback half of the resolution depends on which
 * Nodes the host has, so only the rendering test pins the candidate list.
 */

/** The stub Node: execs whatever it is given, so the stub CLI answers. */
const trampoline = '#!/bin/sh\nexec "$@"\n';

describe("the refresh launcher script", () => {
  const writeLauncher = async (dataDir: string, nodePath: string | undefined): Promise<number | null> => {
    const node = join(dataDir, "stub dir", "stub-node");
    const cli = join(dataDir, "stub-cli.mjs");
    await mkdir(join(dataDir, "stub dir"), { recursive: true });
    await writeFile(node, trampoline);
    await writeFile(cli, '#!/bin/sh\necho "cli ran: $*"\n');
    await chmod(node, 0o755);
    await chmod(cli, 0o755);
    if (nodePath !== undefined) {
      await writeFile(join(dataDir, NODE_PATH_FILE), renderNodePathSeed(nodePath));
    }
    await writeFile(launcherPath(dataDir), renderRefreshLauncher({ dataDir, cliPath: cli }));
    const run = spawnSync("/bin/sh", [launcherPath(dataDir)], { encoding: "utf8" });
    return run.status;
  };

  const stdoutOf = async (dataDir: string): Promise<string> => {
    const run = spawnSync("/bin/sh", [launcherPath(dataDir)], { encoding: "utf8" });
    return run.stdout;
  };

  it("runs the CLI at node-path with refresh", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "snorlax-launcher-"));
    try {
      expect(await writeLauncher(dataDir, join(dataDir, "stub dir", "stub-node"))).toBe(0);
      expect(await stdoutOf(dataDir)).toBe("cli ran: refresh\n");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("reads only the first line of node-path", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "snorlax-launcher-"));
    try {
      const node = join(dataDir, "stub dir", "stub-node");
      const cli = join(dataDir, "stub-cli.mjs");
      await mkdir(join(dataDir, "stub dir"), { recursive: true });
      await writeFile(node, trampoline);
      await writeFile(cli, '#!/bin/sh\necho "cli ran: $*"\n');
      await chmod(node, 0o755);
      await chmod(cli, 0o755);
      await writeFile(join(dataDir, NODE_PATH_FILE), `${renderNodePathSeed(node)}# a second line\n`);
      await writeFile(launcherPath(dataDir), renderRefreshLauncher({ dataDir, cliPath: cli }));
      const run = spawnSync("/bin/sh", [launcherPath(dataDir)], { encoding: "utf8" });
      expect(run.status).toBe(0);
      expect(run.stdout).toBe("cli ran: refresh\n");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("falls through a dead node-path to the first executable fallback when there is one", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "snorlax-launcher-"));
    try {
      // A node-path naming nothing executable. Whether a fallback Node exists is the host's business, so
      // the exit is 1 when one does (the real Node cannot run the sh stub CLI) or 127 when none does —
      // what must never happen is the dead candidate being started: the stub CLI prints nothing.
      const status = await writeLauncher(dataDir, join(dataDir, "gone", "node"));
      expect(status === 1 || status === 127).toBe(true);
      expect(await stdoutOf(dataDir)).toBe("");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
