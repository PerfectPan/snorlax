import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import * as z from "zod/mini";
import { failureSchema, refreshResultSchema, snapshotOutputSchema, statusSchema } from "@rivus/snorlax-protocol";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { makeSnapshot } from "./sample.ts";

/**
 * End-to-end tests against the built bundle (`dist/snorlax.mjs`), run under a temporary `HOME` and
 * `SNORLAX_HOME` so no real agent directory is ever touched. The bundle is built before tests run
 * (`pnpm run check` orders build before test); a bare `pnpm test` needs `pnpm run build` first.
 */
const bundle = fileURLToPath(new URL("../dist/snorlax.mjs", import.meta.url));

// `doctor` asks launchd about the scheduled job on macOS; a launchctl path that does not exist keeps the real
// launchctl out of the tests and creates no stub file in the home whose emptiness they assert.
const run = (args: readonly string[], home: string) =>
  spawnSync(process.execPath, [bundle, ...args], {
    encoding: "utf8",
    env: {
      HOME: home,
      SNORLAX_HOME: join(home, "data"),
      SNORLAX_LAUNCHCTL: join(home, "no-launchctl"),
      PATH: "/usr/bin:/bin"
    }
  });

/** One JSON object and nothing else: a plain-object record, parsed at the boundary with a schema. */
const jsonObjectSchema = z.record(z.string(), z.unknown());

const parseOneJsonObject = (stdout: string): z.output<typeof jsonObjectSchema> => {
  let document: unknown;
  try {
    document = JSON.parse(stdout);
  } catch {
    throw new Error(`stdout is not one JSON object: ${stdout}`);
  }
  return z.parse(jsonObjectSchema, document);
};

let home: string;

beforeAll(async () => {
  if (!existsSync(bundle)) {
    throw new Error(`${bundle} is missing; run "pnpm --filter @rivus/snorlax run build" first`);
  }
  home = await mkdtemp(join(tmpdir(), "snorlax-cli-"));
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("calling convention (plan 3.2.1)", () => {
  it("status --json prints exactly one JSON object that parses as Status, and exits 0", () => {
    const result = run(["status", "--json"], home);
    expect(result.stderr).toBe("");
    expect(parseOneJsonObject(result.stdout).ok).toBe(true);
    const parsed = z.safeParse(statusSchema, JSON.parse(result.stdout));
    expect(parsed.success ? "valid" : z.prettifyError(parsed.error)).toBe("valid");
    expect(result.status).toBe(0);
  });

  it("prints only one line of JSON on stdout", () => {
    const result = run(["status", "--json"], home);
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
  });

  it("status without --json prints human-readable text instead of JSON", () => {
    const result = run(["status"], home);
    expect(result.status).toBe(0);
    expect(result.stdout.startsWith("{")).toBe(false);
    expect(result.stdout).toContain("snorlax");
  });

  it("exits 2 with the failure shape for an unknown command", () => {
    const result = run(["bogus", "--json"], home);
    const failure = z.parse(failureSchema, parseOneJsonObject(result.stdout));
    expect(failure.ok).toBe(false);
    expect(failure.error.code).toBe("invalid-arguments");
    expect(result.status).toBe(2);
  });

  it("exits 2 when no command is given", () => {
    const result = run(["--json"], home);
    expect(z.parse(failureSchema, parseOneJsonObject(result.stdout)).error.code).toBe("invalid-arguments");
    expect(result.status).toBe(2);
  });

  it("exits 2 for an unknown option", () => {
    const result = run(["status", "--nonsense", "--json"], home);
    expect(z.parse(failureSchema, parseOneJsonObject(result.stdout)).error.code).toBe("invalid-arguments");
    expect(result.status).toBe(2);
  });

  it("exits 1 with the failure shape for a command this build does not implement", () => {
    const result = run(["pair", "--json"], home);
    const failure = z.parse(failureSchema, parseOneJsonObject(result.stdout));
    expect(failure.error.code).toBe("internal");
    expect(result.status).toBe(1);
  });

  it("can be repeated safely", () => {
    expect(run(["status", "--json"], home).status).toBe(0);
    expect(run(["status", "--json"], home).status).toBe(0);
  });

  it("redacts effect/cli's own human rendering: an error quoting the command line hides the home", () => {
    const result = run(["status", join(home, "secret-project")], home);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("~/secret-project");
    expect(result.stderr).not.toContain(home);
  });

  it("the output mode follows the parsed --json value, however it was spelled", () => {
    // effect/cli parses a boolean literal after the flag as its value and knows --no-json; the
    // handler sees exactly that value, so these all print human text and exit 0.
    for (const args of [
      ["status", "--json", "false"],
      ["status", "--json", "no"],
      ["status", "--json", "0"],
      ["status", "--no-json", "--json"],
      ["status", "--json=false"]
    ]) {
      const result = run(args, home);
      expect(result.status).toBe(0);
      expect(result.stdout.startsWith("{")).toBe(false);
      expect(result.stdout).toContain("snorlax");
    }
    // --json=true and a bare --json parse to true; effect/cli keeps the first value when the flag is
    // spelled both ways, so --json --no-json stays JSON too.
    for (const args of [
      ["status", "--json"],
      ["status", "--json=true"],
      ["status", "--json", "--no-json"]
    ]) {
      const result = run(args, home);
      expect(result.status).toBe(0);
      expect(parseOneJsonObject(result.stdout).ok).toBe(true);
    }
  });

  it("a --json behind -- is a positional: parse error, human rendering, exit 2", () => {
    const result = run(["status", "--", "--json"], home);
    expect(result.status).toBe(2);
    expect(result.stdout.startsWith("{")).toBe(false);
    expect(result.stderr).toContain("Unexpected");
  });
});

describe("built-in flags", () => {
  it("--help, -h, --version and -v exit 0 in human mode with output on stdout", () => {
    for (const flag of ["--help", "-h", "--version", "-v"]) {
      const result = run([flag], home);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).not.toBe("");
    }
  });

  it("help and version combined with --json print one invalid-arguments object and exit 2", () => {
    for (const args of [
      ["status", "--help", "--json"],
      ["--version", "--json"]
    ]) {
      const result = run(args, home);
      const failure = z.parse(failureSchema, parseOneJsonObject(result.stdout));
      expect(failure.error.code).toBe("invalid-arguments");
      expect(result.stdout.trim().split("\n")).toHaveLength(1);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(2);
    }
  });

  it("--wizard is not a flag: an unknown option, exit 2, no interactive prompt", () => {
    const result = run(["--wizard", "--json"], home);
    expect(z.parse(failureSchema, parseOneJsonObject(result.stdout)).error.code).toBe("invalid-arguments");
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(result.status).toBe(2);
  });
});

describe("data directory", () => {
  it("is not created by read-only commands: status leaves the fresh home empty (plan 3.13)", async () => {
    const fresh = await mkdtemp(join(tmpdir(), "snorlax-cli-readonly-"));
    try {
      expect(run(["status", "--json"], fresh).status).toBe(0);
      expect(run(["doctor", "--json"], fresh).status).toBe(0);
      expect(run(["snapshot", "--json"], fresh).status).toBe(1);
      expect(await readdir(fresh)).toEqual([]);
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  });
});

describe("snapshot command", () => {
  it("exits 1 with code data-dir when no snapshot exists", () => {
    const result = run(["snapshot", "--json"], home);
    expect(z.parse(failureSchema, parseOneJsonObject(result.stdout)).error.code).toBe("data-dir");
    expect(result.status).toBe(1);
  });

  it("prints the snapshot wrapped as SnapshotOutput and feeds status's sync fields from it", async () => {
    await mkdir(join(home, "data"), { recursive: true });
    await writeFile(join(home, "data", "snapshot.json"), `${JSON.stringify(makeSnapshot())}\n`, "utf8");

    const printed = run(["snapshot", "--json"], home);
    expect(printed.status).toBe(0);
    const output = z.parse(snapshotOutputSchema, parseOneJsonObject(printed.stdout));
    expect(output.ok).toBe(true);
    expect(output.snapshot.generatedAt).toBe("2026-10-22T12:00:00.000Z");

    // Sync state and decode failures come from the snapshot (the last refresh's); the device id and last
    // scan come from the ledger (plan 6.8, Batch 2), and no ledger exists in this home yet.
    const status = z.parse(statusSchema, parseOneJsonObject(run(["status", "--json"], home).stdout));
    expect(status.sync).toEqual({ state: "ok", at: "2026-10-22T12:00:00.000Z" });
    expect(status.failuresByAgent).toEqual({});
    expect(status.device.id).toBe(null);
    expect(status.lastScanAt).toBe(null);
  });

  it("accepts the protocol package's committed snapshot fixture", async () => {
    const fixture = await readFile(
      fileURLToPath(new URL("../../protocol/fixtures/snapshot.json", import.meta.url)),
      "utf8"
    );
    await mkdir(join(home, "data"), { recursive: true });
    await writeFile(join(home, "data", "snapshot.json"), fixture, "utf8");
    expect(run(["snapshot", "--json"], home).status).toBe(0);
  });
});

describe("refresh and rebuild", () => {
  // A home of its own: a refresh writes a snapshot, and the suites above assert a home without one.
  let refreshHome: string;

  beforeAll(async () => {
    refreshHome = await mkdtemp(join(tmpdir(), "snorlax-cli-refresh-"));
  });

  afterAll(async () => {
    await rm(refreshHome, { recursive: true, force: true });
  });

  const runRefreshHome = (args: readonly string[]) =>
    spawnSync(process.execPath, [bundle, ...args], {
      encoding: "utf8",
      env: { HOME: refreshHome, SNORLAX_HOME: join(refreshHome, "data"), PATH: "/usr/bin:/bin" }
    });

  it("creates the data directory with mode 0700 on the first writing command", async () => {
    const refreshed = runRefreshHome(["refresh", "--json"]);
    expect(refreshed.stderr).toBe("");
    expect(refreshed.status).toBe(0);
    const mode = (await stat(join(refreshHome, "data"))).mode & 0o777;
    expect(mode.toString(8)).toBe("700");
  });

  it("refresh prints the RefreshResult shape and writes a snapshot the snapshot command prints", () => {
    const refreshed = runRefreshHome(["refresh", "--json"]);
    expect(refreshed.stderr).toBe("");
    expect(refreshed.status).toBe(0);
    const result = z.parse(refreshResultSchema, parseOneJsonObject(refreshed.stdout));
    expect(result).toMatchObject({ ok: true, records: 0, failures: 0, sync: { ok: false, pushed: 0, pulled: 0 } });

    const printed = runRefreshHome(["snapshot", "--json"]);
    expect(printed.status).toBe(0);
    const output = z.parse(snapshotOutputSchema, parseOneJsonObject(printed.stdout));
    expect(output.snapshot.totals.last30d.requests).toBe(0);
  });

  it("rebuild accepts 1-30 days and rejects anything else with exit 2", () => {
    expect(runRefreshHome(["rebuild", "--days", "7", "--json"]).status).toBe(0);
    for (const days of ["0", "31", "many"]) {
      const result = runRefreshHome(["rebuild", "--days", days, "--json"]);
      expect(z.parse(failureSchema, parseOneJsonObject(result.stdout)).error.code).toBe("invalid-arguments");
      expect(result.status).toBe(2);
    }
    const missing = runRefreshHome(["rebuild", "--json"]);
    expect(z.parse(failureSchema, parseOneJsonObject(missing.stdout)).error.code).toBe("invalid-arguments");
    expect(missing.status).toBe(2);
  });

  it("refresh and rebuild log their summary and command lines in the data directory (plan 3.9)", async () => {
    const fresh = await mkdtemp(join(tmpdir(), "snorlax-cli-log-"));
    try {
      expect(run(["refresh"], fresh).status).toBe(0);
      expect(run(["rebuild", "--days", "2"], fresh).status).toBe(0);
      const events = (await readFile(join(fresh, "data", "logs", "snorlax.log"), "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => line.replace(/^\S+ /, "").replace(/"durationMs":\d+/, '"durationMs":0'));
      expect(events).toEqual([
        'refresh {"records":0,"failures":0,"pushed":0,"pulled":0,"durationMs":0}',
        'command {"name":"refresh","exitCode":0,"durationMs":0}',
        'rebuild {"days":2,"records":0,"failures":0,"pushed":0,"pulled":0,"durationMs":0}',
        'command {"name":"rebuild","exitCode":0,"durationMs":0}'
      ]);
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  });
});

describe("ledger and snapshot failures", () => {
  // The ledger and snapshot modules name these failures; cli/ alone turns them into data-dir.
  const inFreshHome = async (prepare: (data: string) => Promise<void>, args: readonly string[]) => {
    const fresh = await mkdtemp(join(tmpdir(), "snorlax-cli-failure-"));
    try {
      await mkdir(join(fresh, "data"));
      await prepare(join(fresh, "data"));
      const result = run(args, fresh);
      return { code: z.parse(failureSchema, parseOneJsonObject(result.stdout)).error.code, status: result.status };
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  };

  it("exits 1 with data-dir when the ledger is not a database or comes from a newer build", async () => {
    const notADatabase = (data: string) => writeFile(join(data, "ledger.db"), "not a database\n", "utf8");
    const newerSchema = async (data: string) => {
      const db = new DatabaseSync(join(data, "ledger.db"));
      try {
        db.exec("PRAGMA user_version = 99");
      } finally {
        db.close();
      }
    };
    expect(await inFreshHome(notADatabase, ["status", "--json"])).toEqual({ code: "data-dir", status: 1 });
    expect(await inFreshHome(notADatabase, ["refresh", "--json"])).toEqual({ code: "data-dir", status: 1 });
    expect(await inFreshHome(newerSchema, ["refresh", "--json"])).toEqual({ code: "data-dir", status: 1 });
  });

  it("exits 1 with data-dir when the snapshot cannot be written", async () => {
    // A non-empty directory in the snapshot's place makes the atomic write's rename fail.
    const occupied = async (data: string) => {
      await mkdir(join(data, "snapshot.json", "occupied"), { recursive: true });
    };
    expect(await inFreshHome(occupied, ["refresh", "--json"])).toEqual({ code: "data-dir", status: 1 });
  });
});
