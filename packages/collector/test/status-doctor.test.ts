import { createMemoryPlatform } from "@rivus/agent-kit/testing";
import { doctorSchema, statusSchema } from "@rivus/snorlax-protocol";
import * as z from "zod/mini";
import { describe, expect, it } from "vite-plus/test";

import type { CollectorPlatform } from "../src/cli/context.ts";
import { runCli } from "../src/cli/main.ts";
import type { NodeFileOps } from "../src/data-dir/node-fs.ts";
import { makeSnapshot } from "./sample.ts";

/**
 * In-process command tests on the agent-kit memory platform: no real file system is touched and the clock is
 * fixed at 2026-10-22T12:00:00Z, so time-derived output is deterministic. They also prove the collector
 * depends only on the platform port and the `NodeFileOps` seam.
 */

const DATA_DIR = "/testroot/tester/snorlax-data";

const createCapture = () => {
  const chunks: string[] = [];
  return { chunks, sink: { write: (text: string): void => void chunks.push(text) } };
};

/** Records appends and simulates the data directory's permission bits; log rotation has its own test. */
const memoryNodeFiles = (mode: () => number | undefined = () => 0o700): NodeFileOps & { appended: string[] } => ({
  appended: [],
  async append(path, data) {
    this.appended.push(`${path}:${data}`);
  },
  async chmod() {},
  mode: async () => mode()
});

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  nodeFiles: NodeFileOps & { appended: string[] };
}

const runCommand = async (
  args: readonly string[],
  files: Record<string, string>,
  deps?: { nodeVersion?: string; mode?: () => number | undefined }
): Promise<RunResult> => {
  const platform: CollectorPlatform = createMemoryPlatform({
    home: "/testroot/tester",
    env: { SNORLAX_HOME: DATA_DIR },
    os: "darwin",
    now: () => 1_792_708_800_000,
    files
  });
  const out = createCapture();
  const err = createCapture();
  const nodeFiles = memoryNodeFiles(deps?.mode);
  const exitCode = await runCli(args, {
    platform,
    nodeFiles,
    version: "0.1.0",
    nodeVersion: deps?.nodeVersion ?? "v24.11.0",
    stdout: out.sink,
    stderr: err.sink
  });
  return { exitCode, stdout: out.chunks.join(""), stderr: err.chunks.join(""), nodeFiles };
};

const failureCodeSchema = z.object({ ok: z.literal(false), error: z.object({ code: z.string() }) });

describe("status", () => {
  it("reports an empty data directory with nulls and unpaired sync, exit 0", async () => {
    const { exitCode, stdout } = await runCommand(["status", "--json"], {});
    const status = z.parse(statusSchema, JSON.parse(stdout));
    expect(status.ok).toBe(true);
    expect(status.dataDir).toBe(DATA_DIR);
    expect(status.device).toEqual({ id: null, name: null });
    expect(status.lastScanAt).toBeNull();
    expect(status.sync).toEqual({ state: "unpaired", at: null });
    expect(status.failuresByAgent).toEqual({});
    expect(exitCode).toBe(0);
  });

  it("lists the builtin agents and never reports runnable (stat-only detection)", async () => {
    const { stdout } = await runCommand(["status", "--json"], {});
    const status = z.parse(statusSchema, JSON.parse(stdout));
    const ids = status.agents.map((agent) => agent.agent);
    expect(ids).toContain("claude-code");
    expect(ids).toContain("codex");
    expect(status.agents.every((agent) => agent.status !== "runnable")).toBe(true);
  });

  it("finds an agent through a path under its home, and reports it missing without one", async () => {
    const absent = await runCommand(["status", "--json"], {});
    const missing = z.parse(statusSchema, JSON.parse(absent.stdout));
    expect(missing.agents.find((agent) => agent.agent === "claude-code")?.status).toBe("missing");

    // `~/.claude/projects` is one of Claude Code's config paths in the builtin recipe; a plain stat on it
    // makes the agent `found` — no command runs and no credential file is read.
    const present = await runCommand(["status", "--json"], { "/testroot/tester/.claude/projects": "" });
    expect(
      z.parse(statusSchema, JSON.parse(present.stdout)).agents.find((agent) => agent.agent === "claude-code")?.status
    ).toBe("found");
  });

  it("fills sync fields from a stored snapshot and the device name from config; scan and id need the ledger", async () => {
    const { stdout } = await runCommand(["status", "--json"], {
      [`${DATA_DIR}/snapshot.json`]: JSON.stringify(makeSnapshot()),
      [`${DATA_DIR}/config.json`]: JSON.stringify({ deviceName: "Studio" })
    });
    const status = z.parse(statusSchema, JSON.parse(stdout));
    // Batch 2: the device id and last scan come from the ledger (absent here); sync state and decode
    // failures stay the last refresh's, persisted in the snapshot.
    expect(status.sync).toEqual({ state: "ok", at: "2026-10-22T12:00:00.000Z" });
    expect(status.device).toEqual({ id: null, name: "Studio" });
    expect(status.lastScanAt).toBe(null);
  });

  it("ignores a snapshot that does not validate instead of failing", async () => {
    const { exitCode, stdout } = await runCommand(["status", "--json"], {
      [`${DATA_DIR}/snapshot.json`]: "{not json"
    });
    expect(z.parse(statusSchema, JSON.parse(stdout)).lastScanAt).toBeNull();
    expect(exitCode).toBe(0);
  });

  it("exits 1 with code data-dir when config.json is present but invalid", async () => {
    const { exitCode, stdout } = await runCommand(["status", "--json"], {
      [`${DATA_DIR}/config.json`]: "{not json"
    });
    expect(z.parse(failureCodeSchema, JSON.parse(stdout)).error.code).toBe("data-dir");
    expect(exitCode).toBe(1);
  });

  it("writes one command line to the log for a successful and a failed run", async () => {
    const ok = await runCommand(["status", "--json"], {});
    expect(ok.nodeFiles.appended).toHaveLength(1);
    expect(ok.nodeFiles.appended[0]).toContain('"name":"status"');
    const failed = await runCommand(["snapshot", "--json"], {});
    expect(failed.nodeFiles.appended[0]).toContain('"error":"data-dir"');
  });
});

describe("doctor", () => {
  it("passes every local check on a healthy directory and exits 0", async () => {
    const { exitCode, stdout } = await runCommand(["doctor", "--json"], {});
    const doctor = z.parse(doctorSchema, JSON.parse(stdout));
    expect(doctor.healthy).toBe(true);
    expect(doctor.checks.map((check) => check.id)).toEqual(["node-version", "data-dir", "config"]);
    expect(exitCode).toBe(0);
  });

  it("still exits 0 when a check fails; healthy reports false", async () => {
    const { exitCode, stdout } = await runCommand(["doctor", "--json"], {}, { nodeVersion: "v22.12.9" });
    const doctor = z.parse(doctorSchema, JSON.parse(stdout));
    expect(doctor.healthy).toBe(false);
    expect(doctor.checks.find((check) => check.id === "node-version")?.status).toBe("error");
    expect(exitCode).toBe(0);
  });

  it("fails the data-dir check when the mode is wider than 0700", async () => {
    const { stdout } = await runCommand(["doctor", "--json"], {}, { mode: () => 0o755 });
    expect(z.parse(doctorSchema, JSON.parse(stdout)).checks.find((check) => check.id === "data-dir")?.status).toBe(
      "error"
    );
  });

  it("fails the config check on a corrupt config.json", async () => {
    const { stdout } = await runCommand(["doctor", "--json"], { [`${DATA_DIR}/config.json`]: "{oops" });
    const doctor = z.parse(doctorSchema, JSON.parse(stdout));
    expect(doctor.checks.find((check) => check.id === "config")?.status).toBe("error");
    expect(doctor.healthy).toBe(false);
  });

  it("redacts the home directory out of check details", async () => {
    const { stdout } = await runCommand(["doctor", "--json"], {});
    expect(stdout).not.toContain("/testroot/tester");
  });
});
