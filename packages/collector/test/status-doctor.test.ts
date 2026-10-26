import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNodePlatform } from "@rivus/agent-kit/node";
import type { Platform } from "@rivus/agent-kit/platform";
import { createMemoryPlatform } from "@rivus/agent-kit/testing";
import { NodeFiles, nodeFileOps, SnorlaxPlatform, type NodeFileOps } from "../src/modules/platform/platform.ts";
import { doctorSchema, statusSchema, type DoctorCheck } from "@rivus/snorlax-protocol";
import { Effect, Layer } from "effect";
import * as z from "zod/mini";
import { describe, expect, it } from "vite-plus/test";

import type { CliJob, JobInspection, LoadedJob } from "../src/capabilities/scheduler/scheduler.ts";
import { runCli } from "../src/cli/run.ts";
import { CliEnv } from "../src/cli/env.ts";
import { doctorPayload, scheduleCheck, type ScheduleObservation } from "../src/commands/doctor/checks.ts";
import { offlineCapabilities } from "./fixtures/capabilities.ts";
import { RuntimeInfo } from "../src/modules/version/version.ts";
import { memoryKitPlatform } from "./fixtures/platform.ts";
import { fakeScheduler } from "./fixtures/scheduler.ts";
import { makeSnapshot } from "./sample.ts";

/**
 * In-process command tests on the agent-kit memory platform: no real file system is touched and the clock is
 * fixed at 2026-10-22T12:00:00Z, so time-derived output is deterministic. They also prove the collector
 * depends only on the platform port and the `NodeFiles` seam. Output is redacted in `cli/`, so paths come
 * out spelled relative to the home (`~/…`). The one exception runs `doctor` on the Node platform over a temporary
 * directory, because only a real file system refuses a `stat` with EACCES.
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

const runOn = async (
  args: readonly string[],
  platform: Platform,
  nodeFiles: NodeFileOps,
  deps?: { nodeVersion?: string; inspection?: JobInspection }
): Promise<Omit<RunResult, "nodeFiles">> => {
  const out = createCapture();
  const err = createCapture();
  const base = Layer.mergeAll(
    Layer.succeed(SnorlaxPlatform, platform),
    Layer.succeed(NodeFiles, nodeFiles),
    fakeScheduler([], { jobFile: "/testroot/tester/job", inspection: deps?.inspection }),
    Layer.succeed(CliEnv, CliEnv.of({ stdout: out.sink, stderr: err.sink, colors: false })),
    Layer.succeed(RuntimeInfo, { version: "0.1.0", nodeVersion: deps?.nodeVersion ?? "v24.11.0" }),
    offlineCapabilities
  );
  const exit = await Effect.runPromise(Effect.flip(runCli(args, base)));
  return { exitCode: exit.exitCode, stdout: out.chunks.join(""), stderr: err.chunks.join("") };
};

const runCommand = async (
  args: readonly string[],
  files: Record<string, string>,
  deps?: { nodeVersion?: string; mode?: () => number | undefined; inspection?: JobInspection }
): Promise<RunResult> => {
  const platform = createMemoryPlatform({
    home: "/testroot/tester",
    env: { SNORLAX_HOME: DATA_DIR },
    os: "darwin",
    now: () => 1_792_708_800_000,
    files
  });
  const nodeFiles = memoryNodeFiles(deps?.mode);
  return { ...(await runOn(args, memoryKitPlatform(platform), nodeFiles, deps)), nodeFiles };
};

const failureCodeSchema = z.object({ ok: z.literal(false), error: z.object({ code: z.string() }) });

/** The config file also makes the memory platform see the data directory itself, so stat finds a dir. */
const withConfig = (config = "{}"): Record<string, string> => ({ [`${DATA_DIR}/config.json`]: config });

describe("status", () => {
  it("reports an empty data directory with nulls and unpaired sync, exit 0", async () => {
    const { exitCode, stdout, nodeFiles } = await runCommand(["status", "--json"], {});
    const status = z.parse(statusSchema, JSON.parse(stdout));
    expect(status.ok).toBe(true);
    // cli/ redacts every output, so the data directory is spelled relative to the home (plan 3.13).
    expect(status.dataDir).toBe("~/snorlax-data");
    expect(status.device).toEqual({ id: null, name: null });
    expect(status.lastScanAt).toBeNull();
    expect(status.sync).toEqual({ state: "unpaired", at: null });
    expect(status.failuresByAgent).toEqual({});
    expect(exitCode).toBe(0);
    // Reading status creates nothing: the appends the logger dropped are the only trace (plan 3.13).
    expect(nodeFiles.appended).toHaveLength(1);
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
    const { exitCode, stdout } = await runCommand(["doctor", "--json"], withConfig());
    const doctor = z.parse(doctorSchema, JSON.parse(stdout));
    expect(doctor.healthy).toBe(true);
    expect(doctor.checks.map((check) => check.id)).toEqual(["node-version", "data-dir", "config", "schedule", "sync"]);
    expect(doctor.checks.find((check) => check.id === "sync")).toEqual({
      id: "sync",
      status: "ok",
      detail: "not paired; sync is off"
    });
    expect(exitCode).toBe(0);
  });

  it("still exits 0 when a check fails; healthy reports false", async () => {
    const { exitCode, stdout } = await runCommand(["doctor", "--json"], withConfig(), { nodeVersion: "v22.12.9" });
    const doctor = z.parse(doctorSchema, JSON.parse(stdout));
    expect(doctor.healthy).toBe(false);
    expect(doctor.checks.find((check) => check.id === "node-version")?.status).toBe("error");
    expect(doctor.checks.find((check) => check.id === "data-dir")?.status).toBe("ok");
    expect(exitCode).toBe(0);
  });

  it("reports a missing data directory as a failed check and creates nothing", async () => {
    const { stdout } = await runCommand(["doctor", "--json"], {});
    const doctor = z.parse(doctorSchema, JSON.parse(stdout));
    expect(doctor.checks.find((check) => check.id === "data-dir")?.status).toBe("error");
    expect(doctor.healthy).toBe(false);
  });

  it("fails the data-dir check when the mode is wider than 0700", async () => {
    const { stdout } = await runCommand(["doctor", "--json"], withConfig(), { mode: () => 0o755 });
    expect(z.parse(doctorSchema, JSON.parse(stdout)).checks.find((check) => check.id === "data-dir")?.status).toBe(
      "error"
    );
  });

  it("fails the config check on a corrupt config.json", async () => {
    const { stdout } = await runCommand(["doctor", "--json"], withConfig("{oops"));
    const doctor = z.parse(doctorSchema, JSON.parse(stdout));
    expect(doctor.checks.find((check) => check.id === "config")?.status).toBe("error");
    expect(doctor.checks.find((check) => check.id === "sync")).toBeUndefined();
    expect(doctor.healthy).toBe(false);
  });

  it("redacts the home directory out of check details", async () => {
    const { stdout } = await runCommand(["doctor", "--json"], withConfig());
    expect(stdout).not.toContain("/testroot/tester");
  });

  it("checks the Node binary the scheduler's job names on disk", async () => {
    const nodePath = "/testroot/tester/.nvm/versions/node/v22.13.0/bin/node";
    const inspection: JobInspection = {
      kind: "inspected",
      cliJob: { file: "/testroot/tester/Library/LaunchAgents/job.plist", nodePath },
      loaded: { from: "cli", file: "/testroot/tester/Library/LaunchAgents/job.plist" }
    };
    const scheduleOf = (stdout: string) => {
      const doctor = z.parse(doctorSchema, JSON.parse(stdout));
      return { healthy: doctor.healthy, check: doctor.checks.find((check) => check.id === "schedule") };
    };

    const gone = scheduleOf((await runCommand(["doctor", "--json"], withConfig(), { inspection })).stdout);
    expect(gone.check?.status).toBe("error");
    expect(gone.check?.detail).toContain("~/.nvm/versions/node/v22.13.0/bin/node, which does not exist");
    expect(gone.healthy).toBe(false);

    const present = { ...withConfig(), [nodePath]: "#!" };
    const runnable = scheduleOf((await runCommand(["doctor", "--json"], present, { inspection })).stdout);
    expect(runnable).toEqual({ healthy: true, check: expect.objectContaining({ status: "ok" }) });

    const notExecutable = scheduleOf(
      (await runCommand(["doctor", "--json"], present, { inspection, mode: () => 0o644 })).stdout
    );
    expect(notExecutable.check?.detail).toContain("is not executable");
  });

  it("fails only the schedule check, and still exits 0, when the job's Node path cannot be checked", async () => {
    // A real directory this user cannot search: there the kit's stat throws EACCES instead of reporting nothing.
    const home = await mkdtemp(join(tmpdir(), "snorlax-doctor-"));
    const locked = join(home, "locked");
    try {
      await mkdir(join(home, "data"), { mode: 0o700 });
      await mkdir(locked);
      await writeFile(join(locked, "node"), "#!", { mode: 0o755 });
      await chmod(locked, 0o000);
      const plist = join(home, "Library", "LaunchAgents", "job.plist");
      const { exitCode, stdout } = await runOn(
        ["doctor", "--json"],
        createNodePlatform({ home, env: { SNORLAX_HOME: join(home, "data"), PATH: "/usr/bin:/bin" } }),
        { ...nodeFileOps, append: async () => {} },
        {
          inspection: {
            kind: "inspected",
            cliJob: { file: plist, nodePath: join(locked, "node") },
            loaded: { from: "cli", file: plist }
          }
        }
      );
      expect(exitCode).toBe(0);
      const doctor = z.parse(doctorSchema, JSON.parse(stdout));
      expect(doctor.checks.map((check) => [check.id, check.status])).toEqual([
        ["node-version", "ok"],
        ["data-dir", "ok"],
        ["config", "ok"],
        ["schedule", "error"],
        ["sync", "ok"]
      ]);
      expect(doctor.checks.find((check) => check.id === "schedule")?.detail).toMatch(
        /^cannot check the Node at ~\/locked\/node that ~\/Library\/LaunchAgents\/job\.plist runs: EACCES/
      );
      expect(doctor.healthy).toBe(false);
    } finally {
      // rm cannot empty a directory it cannot search.
      if (existsSync(locked)) {
        await chmod(locked, 0o700);
      }
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("the schedule check", () => {
  const PLIST = "/opt/snorlax-test/home/Library/LaunchAgents/io.github.perfectpan.snorlax.refresh.plist";
  const APP = "/Applications/Snorlax.app/Contents/Library/LaunchAgents/io.github.perfectpan.snorlax.refresh.plist";
  const NODE = "/opt/snorlax-test/home/.nvm/versions/node/v22.13.0/bin/node";
  const cliJob: CliJob = { file: PLIST, nodePath: NODE };
  const inspected = (job: CliJob | undefined, loaded: LoadedJob): JobInspection => ({
    kind: "inspected",
    cliJob: job,
    loaded
  });
  const cases: [string, ScheduleObservation, DoctorCheck["status"], string][] = [
    [
      "a system this build cannot schedule on",
      { job: { kind: "unsupported", reason: "no launchd here" }, node: undefined },
      "warn",
      "no launchd here"
    ],
    [
      "the app's Launch at login",
      { job: inspected(undefined, { from: "app", file: APP }), node: undefined },
      "ok",
      `Launch at login schedules refresh (${APP})`
    ],
    [
      "the app's Launch at login next to the CLI's plist",
      { job: inspected(cliJob, { from: "app", file: APP }), node: "missing" },
      "warn",
      "turn Launch at login off, run `snorlax uninstall`"
    ],
    [
      "the CLI's job, loaded, on a runnable Node",
      { job: inspected(cliJob, { from: "cli", file: PLIST }), node: "runnable" },
      "ok",
      `is loaded and runs Node at ${NODE}`
    ],
    [
      "the CLI's job on a Node that is gone",
      { job: inspected(cliJob, { from: "cli", file: PLIST }), node: "missing" },
      "error",
      `runs Node at ${NODE}, which does not exist`
    ],
    [
      "the CLI's job on a Node that is not executable",
      { job: inspected(cliJob, { from: "nothing" }), node: "not-executable" },
      "error",
      "which is not executable"
    ],
    [
      "the CLI's plist that launchd has not loaded",
      { job: inspected(cliJob, { from: "nothing" }), node: "runnable" },
      "warn",
      "launchd has not loaded it"
    ],
    [
      "the CLI's plist when the loaded job's source is unknown",
      { job: inspected(cliJob, { from: "unknown", reason: "launchctl did not finish" }), node: "runnable" },
      "warn",
      "launchctl did not finish"
    ],
    [
      "the CLI's plist without a Node path snorlax can read",
      { job: inspected({ file: PLIST, nodePath: undefined }, { from: "cli", file: PLIST }), node: undefined },
      "warn",
      "cannot read the Node path"
    ],
    [
      "the CLI's job loaded after its plist was deleted",
      { job: inspected(undefined, { from: "cli", file: PLIST }), node: undefined },
      "warn",
      `${PLIST} is gone`
    ],
    [
      "a loaded job whose source is unknown",
      { job: inspected(undefined, { from: "unknown", reason: "print names no plist" }), node: undefined },
      "warn",
      "print names no plist"
    ],
    ["nothing scheduled", { job: inspected(undefined, { from: "nothing" }), node: undefined }, "warn", "not scheduled"]
  ];

  it.each(cases)("%s", (_, observed, status, detail) => {
    const check = scheduleCheck(observed);
    expect(check).toEqual({ id: "schedule", status, detail: expect.stringContaining(detail) });
  });

  it("says how to recover from a Node that is gone", () => {
    const { detail } = scheduleCheck({ job: inspected(cliJob, { from: "cli", file: PLIST }), node: "missing" });
    expect(detail).toContain("run `snorlax install` again");
    expect(detail).toContain("turn on Launch at login in Snorlax's Settings");
  });

  const UNIT = "/opt/snorlax-test/home/.config/systemd/user/snorlax-refresh.service";
  const TIMER = "/opt/snorlax-test/home/.config/systemd/user/snorlax-refresh.timer";
  const unitJob: CliJob = { file: UNIT, nodePath: NODE };
  const systemd = (job: CliJob | undefined, loaded: LoadedJob): JobInspection => ({
    kind: "inspected",
    scheduler: "systemd",
    cliJob: job,
    loaded
  });
  const systemdCases: [string, ScheduleObservation, DoctorCheck["status"], string][] = [
    [
      "the systemd user timer running on a runnable Node",
      { job: systemd(unitJob, { from: "cli", file: TIMER }), node: "runnable" },
      "ok",
      "the systemd user timer is running"
    ],
    [
      "the Node named in the unit file does not exist",
      { job: systemd(unitJob, { from: "cli", file: TIMER }), node: "missing" },
      "error",
      `the Node in ${UNIT} does not exist (${NODE})`
    ],
    [
      "the Node named in the unit file is not executable",
      { job: systemd(unitJob, { from: "nothing" }), node: "not-executable" },
      "error",
      `the Node in ${UNIT} is not executable (${NODE})`
    ],
    [
      "a Node the user cannot check",
      { job: systemd(unitJob, { from: "cli", file: TIMER }), node: { unchecked: "EACCES: permission denied" } },
      "error",
      `cannot check the Node at ${NODE} that ${UNIT} runs: EACCES: permission denied`
    ],
    [
      "a unit file whose timer is not running",
      { job: systemd(unitJob, { from: "nothing" }), node: "runnable" },
      "warn",
      "the systemd user timer is not running"
    ],
    [
      "a unit file when the loaded timer's source is unknown",
      { job: systemd(unitJob, { from: "unknown", reason: "systemctl did not finish" }), node: "runnable" },
      "warn",
      "cannot tell whether systemd runs"
    ],
    [
      "a unit file without a Node path snorlax can read",
      { job: systemd({ file: UNIT, nodePath: undefined }, { from: "cli", file: TIMER }), node: undefined },
      "warn",
      "cannot read the Node path"
    ],
    [
      "the timer loaded after its service unit was deleted",
      { job: systemd(undefined, { from: "cli", file: TIMER }), node: undefined },
      "warn",
      "the service unit it starts is gone"
    ],
    [
      "a loaded timer whose source is unknown",
      { job: systemd(undefined, { from: "unknown", reason: "show did not parse" }), node: undefined },
      "warn",
      "cannot confirm the timer's state: show did not parse"
    ],
    [
      "a timer reported as the app's",
      { job: systemd(undefined, { from: "app", file: TIMER }), node: undefined },
      "warn",
      "not a unit file snorlax install writes"
    ],
    [
      "nothing scheduled on Linux",
      { job: systemd(undefined, { from: "nothing" }), node: undefined },
      "warn",
      "refresh is not scheduled: run `snorlax install`"
    ]
  ];

  it.each(systemdCases)("%s", (_, observed, status, detail) => {
    const check = scheduleCheck(observed);
    expect(check).toEqual({ id: "schedule", status, detail: expect.stringContaining(detail) });
    expect(check.detail).not.toContain("Launch at login");
    expect(check.detail).not.toContain("Snorlax.app");
    expect(doctorPayload([check]).healthy).toBe(status !== "error");
  });
});
