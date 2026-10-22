import { createNodePlatform } from "@rivus/agent-kit/node";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { nodeFileOps } from "../src/data-dir/node-fs.ts";
import { createLogger, LOG_FILES_KEPT } from "../src/log/logger.ts";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

/**
 * Log behavior against the real file system under a temporary directory (rotation renames and re-reads real
 * files); timestamps are only format-checked, never compared to the wall clock.
 */
let dataDir: string;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "snorlax-log-"));
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const logPath = (): string => join(dataDir, "logs", "snorlax.log");

describe("createLogger (plan 3.9)", () => {
  it("writes one line per event with an ISO timestamp prefix", async () => {
    const platform = createNodePlatform({ home: dataDir });
    const logger = await createLogger(platform, nodeFileOps, dataDir);
    await logger.event("command", { name: "status", exitCode: 0 });
    await logger.event("refresh-summary", { records: 412, failures: 0 });

    const lines = (await readFile(logPath(), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z command /);
    expect(lines[0]).toContain('"name":"status"');
  });

  it("redacts home paths and secret-shaped values from every line", async () => {
    const platform = createNodePlatform({ home: dataDir });
    const logger = await createLogger(platform, nodeFileOps, dataDir);
    await logger.event("probe", { path: `${dataDir}/sessions`, token: "sk-ant-api03-abcdef" });

    const line = (await readFile(logPath(), "utf8")).trim().split("\n").at(-1) ?? "";
    expect(line).not.toContain(dataDir);
    expect(line).toContain("~/sessions");
    expect(line).not.toContain("sk-ant-api03");
  });

  it("rotates at the threshold and keeps exactly three files, dropping the oldest", async () => {
    // A fresh data directory per logger so earlier tests' lines do not count towards the threshold.
    const rotateDir = await mkdtemp(join(tmpdir(), "snorlax-rotate-"));
    try {
      const platform = createNodePlatform({ home: rotateDir });
      const logger = await createLogger(platform, nodeFileOps, rotateDir, { maxBytes: 240 });
      for (let index = 0; index < 12; index += 1) {
        await logger.event("tick", { index });
      }

      const logs = join(rotateDir, "logs");
      const current = (await readFile(join(logs, "snorlax.log"), "utf8")).trim().split("\n");
      const first = (await readFile(join(logs, "snorlax.log.1"), "utf8")).trim().split("\n");
      const second = (await readFile(join(logs, "snorlax.log.2"), "utf8")).trim().split("\n");

      // .2 holds the oldest surviving generation, .1 the middle one, the current file the newest ticks.
      expect(second[0]).toContain('"index":0');
      expect(first[0]).toContain('"index":5');
      expect(current.at(-1)).toContain('"index":11');
      const files = (await readdir(logs)).sort();
      expect(files).toHaveLength(LOG_FILES_KEPT);
      expect(files[0]).toBe("snorlax.log");
    } finally {
      await rm(rotateDir, { recursive: true, force: true });
    }
  });

  it("never fails the command when the log directory disappears", async () => {
    const platform = createNodePlatform({ home: dataDir });
    const logger = await createLogger(platform, nodeFileOps, dataDir);
    await rm(join(dataDir, "logs"), { recursive: true, force: true });
    await expect(logger.event("after-remove")).resolves.toBeUndefined();
  });
});
