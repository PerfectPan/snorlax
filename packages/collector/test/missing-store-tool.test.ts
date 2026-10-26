import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { okSchema, refreshResultSchema, snapshotOutputSchema } from "@rivus/snorlax-protocol";
import type { Platform } from "@rivus/agent-kit/platform";
import { Effect, Layer } from "effect";
import * as z from "zod/mini";
import { describe, expect, it } from "vite-plus/test";

import { Backend } from "../src/capabilities/backend/backend.ts";
import { Secrets } from "../src/capabilities/secrets/secrets.ts";
import { CliEnv } from "../src/cli/env.ts";
import { runCli } from "../src/cli/run.ts";
import { configSchema } from "../src/modules/config/config.ts";
import { NodeFiles, SnorlaxPlatform } from "../src/modules/platform/platform.ts";
import { TimeZone } from "../src/modules/time-zone/time-zone.ts";
import { createRefreshSetup, type TestPlatform } from "./fixtures/platform.ts";
import { fakeScheduler } from "./fixtures/scheduler.ts";

/**
 * A missing `security` or `secret-tool` program is an absent item for read and delete. uninstall, unpair and
 * refresh then finish. The spawn wrapper refuses the real binaries, so a fall-through fails the test before
 * they start.
 */

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const BASE = "https://snorlax.test";
const REAL_SECURITY = "/usr/bin/security";
const REAL_SECRET_TOOL = "secret-tool";

const offlineFetch = (request: Request): Promise<Response> => Promise.reject(new Error(`offline (${request.method})`));

const createCapture = () => {
  const chunks: string[] = [];
  return { chunks, sink: { write: (text: string): void => void chunks.push(text) } };
};

const open = async (store: "keychain" | "libsecret") => {
  const setup = await createRefreshSetup({ now: NOW });
  const missingSecurity = join(setup.home, "missing-security");
  const missingSecretTool = join(setup.home, "missing-secret-tool");
  const spawned: string[] = [];
  const env = {
    ...setup.platform.env,
    PATH: "/usr/bin:/bin",
    SNORLAX_HOME: setup.dataDir,
    SNORLAX_SECURITY: missingSecurity,
    SNORLAX_SECRET_TOOL: missingSecretTool
  };
  const spawn = ((command: string, args: readonly string[], options: Parameters<Platform["process"]["spawn"]>[2]) => {
    spawned.push(command);
    if (command === REAL_SECURITY || command === REAL_SECRET_TOOL) {
      throw new Error(`refused real store tool ${command}`);
    }
    return setup.platform.process.spawn(command, args, options);
  }) as Platform["process"]["spawn"];
  const platform: TestPlatform = {
    ...setup.platform,
    env,
    process: { ...setup.platform.process, spawn }
  };
  const secrets = Layer.provide(
    store === "keychain" ? Secrets.keychain : Secrets.libsecret,
    Layer.succeed(SnorlaxPlatform, platform)
  );
  const run = async (args: readonly string[]) => {
    const out = createCapture();
    const err = createCapture();
    const exit = await Effect.runPromise(
      Effect.flip(
        runCli(
          args,
          Layer.mergeAll(
            Layer.succeed(SnorlaxPlatform, platform),
            NodeFiles.live,
            fakeScheduler([], { jobFile: join(setup.home, "job") }),
            Layer.succeed(CliEnv, CliEnv.of({ stdout: out.sink, stderr: err.sink, colors: false })),
            secrets,
            Backend.layer(offlineFetch),
            Layer.succeed(TimeZone, "UTC")
          )
        )
      )
    );
    return { exitCode: exit.exitCode, stdout: out.chunks.join(""), stderr: err.chunks.join("") };
  };
  return {
    setup,
    spawned,
    missing: store === "keychain" ? missingSecurity : missingSecretTool,
    run,
    close: () => setup.remove()
  };
};

const assertNoRealTool = (spawned: readonly string[]): void => {
  expect(spawned).not.toContain(REAL_SECURITY);
  expect(spawned).not.toContain(REAL_SECRET_TOOL);
};

describe.each(["keychain", "libsecret"] as const)("missing %s program", (store) => {
  it("uninstall --data finishes and deletes the data directory", async () => {
    const harness = await open(store);
    try {
      expect((await harness.run(["refresh", "--json"])).exitCode).toBe(0);
      const removed = await harness.run(["uninstall", "--data", "--json"]);
      expect(removed.stderr).toBe("");
      expect(removed.exitCode).toBe(0);
      expect(z.parse(okSchema, JSON.parse(removed.stdout)).ok).toBe(true);
      expect(existsSync(harness.setup.dataDir)).toBe(false);
      expect(harness.spawned).toContain(harness.missing);
      assertNoRealTool(harness.spawned);
    } finally {
      await harness.close();
    }
  });

  it("unpair drops the backend URL and rewrites an unpaired snapshot", async () => {
    const harness = await open(store);
    try {
      expect((await harness.run(["refresh", "--json"])).exitCode).toBe(0);
      await writeFile(
        join(harness.setup.dataDir, "config.json"),
        `${JSON.stringify({ backendUrl: BASE, deviceName: "Desk" })}\n`
      );
      const unpaired = await harness.run(["unpair", "--json"]);
      expect(unpaired.exitCode).toBe(0);
      expect(z.parse(okSchema, JSON.parse(unpaired.stdout)).ok).toBe(true);
      const snapshot = await harness.run(["snapshot", "--json"]);
      expect(snapshot.exitCode).toBe(0);
      const body = z.parse(snapshotOutputSchema, JSON.parse(snapshot.stdout)).snapshot;
      expect(body.status.paired).toBe(false);
      expect(body.status.sync.state).toBe("unpaired");
      const config = z.parse(
        configSchema,
        JSON.parse(await readFile(join(harness.setup.dataDir, "config.json"), "utf8"))
      );
      expect(config.backendUrl).toBeUndefined();
      expect(config.deviceName).toBe("Desk");
      expect(harness.spawned).toContain(harness.missing);
      assertNoRealTool(harness.spawned);
    } finally {
      await harness.close();
    }
  });

  it("refresh reports unpaired when the program cannot be started", async () => {
    const harness = await open(store);
    try {
      expect((await harness.run(["refresh", "--json"])).exitCode).toBe(0);
      await writeFile(
        join(harness.setup.dataDir, "config.json"),
        `${JSON.stringify({ backendUrl: BASE, deviceName: "Desk" })}\n`
      );
      const refreshed = await harness.run(["refresh", "--json"]);
      expect(refreshed.stderr).toBe("");
      expect(refreshed.exitCode).toBe(0);
      expect(z.parse(refreshResultSchema, JSON.parse(refreshed.stdout)).sync.state).toBe("unpaired");
      const snapshot = await harness.run(["snapshot", "--json"]);
      const body = z.parse(snapshotOutputSchema, JSON.parse(snapshot.stdout)).snapshot;
      expect(body.status.paired).toBe(false);
      expect(body.status.sync.state).toBe("unpaired");
      expect(harness.spawned).toContain(harness.missing);
      assertNoRealTool(harness.spawned);
      expect(refreshed.stdout).not.toContain(REAL_SECURITY);
      expect(refreshed.stdout).not.toContain(REAL_SECRET_TOOL);
    } finally {
      await harness.close();
    }
  });
});
