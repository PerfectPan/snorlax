import { createNodePlatform } from "@rivus/agent-kit/node";
import { createMemoryPlatform } from "@rivus/agent-kit/testing";
import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureDataDir, resolveDataDir } from "../src/data-dir/data-dir.ts";
import { nodeFileOps } from "../src/data-dir/node-fs.ts";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

let tempRoot: string;

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "snorlax-data-"));
});

afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("resolveDataDir (plan 3.4.1 step 1)", () => {
  it("prefers SNORLAX_HOME over every platform default", () => {
    const platform = createMemoryPlatform({
      home: "/testroot/tester",
      os: "darwin",
      env: { SNORLAX_HOME: "/tmp/snorlax-test-home" }
    });
    expect(resolveDataDir(platform)).toBe("/tmp/snorlax-test-home");
  });

  it("uses ~/Library/Application Support/snorlax on macOS", () => {
    const platform = createMemoryPlatform({ home: "/testroot/tester", os: "darwin", env: {} });
    expect(resolveDataDir(platform)).toBe("/testroot/tester/Library/Application Support/snorlax");
  });

  it("follows XDG_DATA_HOME on Linux and falls back to ~/.local/share", () => {
    const withXdg = createMemoryPlatform({
      home: "/testroot/tester",
      os: "linux",
      env: { XDG_DATA_HOME: "/srv/data" }
    });
    expect(resolveDataDir(withXdg)).toBe("/srv/data/snorlax");
    const withoutXdg = createMemoryPlatform({ home: "/testroot/tester", os: "linux", env: {} });
    expect(resolveDataDir(withoutXdg)).toBe("/testroot/tester/.local/share/snorlax");
  });
});

describe("ensureDataDir", () => {
  // Real file system: the check is about actual permission bits.
  it("creates the directory with mode 0700, including parents", async () => {
    const platform = createNodePlatform({ home: tempRoot });
    const path = join(tempRoot, "nested", "snorlax");
    await ensureDataDir(platform, nodeFileOps, path);
    expect(((await stat(path)).mode & 0o777).toString(8)).toBe("700");
  });

  it("tightens an existing directory that is wider than 0700", async () => {
    const platform = createNodePlatform({ home: tempRoot });
    const path = join(tempRoot, "loose");
    await mkdir(path, { recursive: true, mode: 0o755 });
    await chmod(path, 0o755);
    await ensureDataDir(platform, nodeFileOps, path);
    expect(((await stat(path)).mode & 0o777).toString(8)).toBe("700");
  });
});
