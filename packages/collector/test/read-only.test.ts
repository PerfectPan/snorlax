import { createNodePlatform } from "@rivus/agent-kit/node";
import { Effect, Layer } from "effect";
import { mkdtemp, readdir, readFile, rm, stat, writeFile, chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { doctorSchema, failureSchema } from "@rivus/snorlax-protocol";
import * as z from "zod/mini";

import { CliEnv } from "../src/cli/env.ts";
import { runCli } from "../src/cli/run.ts";
import { NodeFiles, SnorlaxPlatform } from "../src/modules/platform/platform.ts";
import { fakeScheduler } from "./fixtures/scheduler.ts";

/**
 * The read-only commands on a real file system under a temporary home (never a real agent home):
 * `status`, `doctor` and `snapshot` must answer without creating or changing anything (plan 3.13),
 * `doctor` reports a missing directory, a directory that is a file and a wrong mode as failed checks
 * with exit 0, and every human output is redacted in `cli/`. The permission bits here are real
 * `chmod` calls, not stand-ins.
 */

let home: string;
let dataDir: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "snorlax-readonly-"));
  dataDir = join(home, "data");
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** Every byte under `home` before and after a run; equality proves the command touched nothing. */
const fingerprint = async (root: string = home): Promise<string> => {
  const paths: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        paths.push(`dir ${path}`);
        await walk(path);
        continue;
      }
      const mode = ((await stat(path)).mode & 0o777).toString(8);
      const content = (await readFile(path)).toString("base64");
      paths.push(`file ${path}:${mode}:${content}`);
    }
  };
  await walk(root);
  return paths.join("\n");
};

interface RunOutcome {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runCommand = async (args: readonly string[]): Promise<RunOutcome> => {
  const platform = createNodePlatform({ home, env: { SNORLAX_HOME: dataDir, PATH: "/usr/bin:/bin" } });
  const chunks = { out: [] as string[], err: [] as string[] };
  const base = Layer.mergeAll(
    Layer.succeed(SnorlaxPlatform, platform),
    NodeFiles.live,
    fakeScheduler([], { jobFile: join(home, "job") }),
    Layer.succeed(
      CliEnv,
      CliEnv.of({
        stdout: { write: (text) => void chunks.out.push(text) },
        stderr: { write: (text) => void chunks.err.push(text) },
        colors: false
      })
    )
  );
  const exit = await Effect.runPromise(Effect.flip(runCli(args, base)));
  return { exitCode: exit.exitCode, stdout: chunks.out.join(""), stderr: chunks.err.join("") };
};

describe("read-only commands create nothing (plan 3.13)", () => {
  it("status answers on an empty home and creates no data directory", async () => {
    const outcome = await runCommand(["status", "--json"]);
    expect(outcome.exitCode).toBe(0);
    expect(await readdir(home)).toEqual([]);
  });

  it("snapshot fails with data-dir on an empty home and creates no data directory", async () => {
    const outcome = await runCommand(["snapshot", "--json"]);
    expect(outcome.exitCode).toBe(1);
    expect(z.parse(failureSchema, JSON.parse(outcome.stdout)).error.code).toBe("data-dir");
    expect(await readdir(home)).toEqual([]);
  });

  it("doctor reports a missing data directory as a failed check and changes nothing", async () => {
    const before = await fingerprint();
    const outcome = await runCommand(["doctor", "--json"]);
    const parsed = z.parse(doctorSchema, JSON.parse(outcome.stdout));
    const check = parsed.checks.find((entry) => entry.id === "data-dir");
    expect(check?.status).toBe("error");
    expect(parsed.healthy).toBe(false);
    expect(outcome.exitCode).toBe(0);
    expect(await fingerprint()).toBe(before);
  });

  it("doctor reports a data directory that is a regular file as a failed check and changes nothing", async () => {
    await writeFile(dataDir, "not a directory\n", "utf8");
    const before = await fingerprint();
    const outcome = await runCommand(["doctor", "--json"]);
    const parsed = z.parse(doctorSchema, JSON.parse(outcome.stdout));
    const check = parsed.checks.find((entry) => entry.id === "data-dir");
    expect(check?.status).toBe("error");
    expect(check?.detail).toContain("is not a directory");
    expect(parsed.healthy).toBe(false);
    expect(await fingerprint()).toBe(before);
  });

  it("doctor reports a mode wider than 0700 as a failed check and changes nothing", async () => {
    await mkdir(dataDir, { recursive: true });
    await chmod(dataDir, 0o755);
    const before = await fingerprint();
    const outcome = await runCommand(["doctor", "--json"]);
    const parsed = z.parse(doctorSchema, JSON.parse(outcome.stdout));
    const check = parsed.checks.find((entry) => entry.id === "data-dir");
    expect(check?.status).toBe("error");
    expect(check?.detail).toContain("755");
    expect(parsed.healthy).toBe(false);
    expect(await fingerprint()).toBe(before);
  });

  it("human doctor output names no absolute path: the home is redacted by cli/", async () => {
    await mkdir(dataDir, { recursive: true });
    await chmod(dataDir, 0o755);
    const outcome = await runCommand(["doctor"]);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain("data-dir: error");
    expect(outcome.stdout).not.toContain(home);
    expect(outcome.stderr).not.toContain(home);
  });
});
