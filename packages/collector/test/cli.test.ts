import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as z from "zod/mini";
import { failureSchema, statusSchema } from "@rivus/snorlax-protocol";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { makeSnapshot } from "./sample.ts";

/**
 * End-to-end tests against the built bundle (`dist/snorlax.mjs`), run under a temporary `HOME` and
 * `SNORLAX_HOME` so no real agent directory is ever touched. The bundle is built before tests run
 * (`pnpm run check` orders build before test); a bare `pnpm test` needs `pnpm run build` first.
 */
const bundle = fileURLToPath(new URL("../dist/snorlax.mjs", import.meta.url));

const run = (args: readonly string[], home: string) =>
  spawnSync(process.execPath, [bundle, ...args], {
    encoding: "utf8",
    env: { HOME: home, SNORLAX_HOME: join(home, "data"), PATH: "/usr/bin:/bin" }
  });

const parseOneJsonObject = (stdout: string): Record<string, unknown> => {
  const document: unknown = JSON.parse(stdout);
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new Error(`stdout is not one JSON object: ${stdout}`);
  }
  return document as Record<string, unknown>;
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
});

describe("data directory", () => {
  it("is created with mode 0700 by the first command", async () => {
    run(["status", "--json"], home);
    const mode = (await stat(join(home, "data"))).mode & 0o777;
    expect(mode.toString(8)).toBe("700");
  });

  it("never touches directories outside it: the temp HOME holds only the data directory", async () => {
    run(["status", "--json"], home);
    expect(await readdir(home)).toEqual(["data"]);
  });
});

describe("snapshot command", () => {
  it("exits 1 with code data-dir when no snapshot exists", () => {
    const result = run(["snapshot", "--json"], home);
    expect(z.parse(failureSchema, parseOneJsonObject(result.stdout)).error.code).toBe("data-dir");
    expect(result.status).toBe(1);
  });

  it("prints a stored snapshot and feeds status's sync fields from it", async () => {
    await writeFile(join(home, "data", "snapshot.json"), `${JSON.stringify(makeSnapshot())}\n`, "utf8");

    const printed = run(["snapshot", "--json"], home);
    expect(printed.status).toBe(0);
    expect(JSON.parse(printed.stdout).generatedAt).toBe("2026-10-22T12:00:00.000Z");

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

  it("refresh prints the RefreshResult shape and writes a snapshot the snapshot command prints", () => {
    const refreshed = runRefreshHome(["refresh", "--json"]);
    expect(refreshed.stderr).toBe("");
    expect(refreshed.status).toBe(0);
    const result: unknown = JSON.parse(refreshed.stdout);
    expect(result).toMatchObject({ ok: true, records: 0, failures: 0, sync: { ok: false, pushed: 0, pulled: 0 } });

    const printed = runRefreshHome(["snapshot", "--json"]);
    expect(printed.status).toBe(0);
    expect(JSON.parse(printed.stdout).totals.last30d.requests).toBe(0);
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
});
