import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

import { failureSchema, okSchema } from "@rivus/snorlax-protocol";
import { Effect, Layer } from "effect";
import * as z from "zod/mini";
import { describe, expect, it } from "vite-plus/test";

import { Backend } from "../src/capabilities/backend/backend.ts";
import { KeychainUnavailable, Secrets } from "../src/capabilities/secrets/secrets.ts";
import type { SchedulerCall } from "./fixtures/scheduler.ts";
import { CliEnv } from "../src/cli/env.ts";
import { runCli } from "../src/cli/run.ts";
import { NodeFiles, SnorlaxPlatform } from "../src/modules/platform/platform.ts";
import { createRefreshSetup, type TestPlatform } from "./fixtures/platform.ts";
import { fakeScheduler } from "./fixtures/scheduler.ts";

/**
 * `uninstall --data` deletes the keychain item after the scheduler and before the data directory.
 * A delete failure keeps the directory. Without `--data` the item stays. No ledger skips the delete.
 */

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const deviceSchema = z.object({ device_id: z.string() });

const offlineFetch = (request: Request): Promise<Response> => Promise.reject(new Error(`offline (${request.method})`));

const createCapture = () => {
  const chunks: string[] = [];
  return { chunks, sink: { write: (text: string): void => void chunks.push(text) } };
};

const deviceIdOf = (dataDir: string): string => {
  const db = new DatabaseSync(join(dataDir, "ledger.db"), { readOnly: true, timeout: 200 });
  try {
    return z.parse(deviceSchema, db.prepare("SELECT device_id FROM meta WHERE id = 0").get()).device_id;
  } finally {
    db.close();
  }
};

describe("uninstall keychain item", () => {
  const start = async () => {
    const setup = await createRefreshSetup({ now: NOW });
    const items = new Map<string, string>();
    const trace: string[] = [];
    const calls: SchedulerCall[] = [];
    const pushCall = calls.push.bind(calls);
    calls.push = (call: SchedulerCall) => {
      trace.push(`scheduler ${call.operation}`);
      return pushCall(call);
    };
    let failDelete = false;
    const secrets = Layer.succeed(
      Secrets,
      Secrets.of({
        read: (deviceId) => Effect.succeed(items.get(deviceId)),
        store: (deviceId, token) =>
          Effect.sync(() => {
            items.set(deviceId, token);
            trace.push("keychain store");
          }),
        delete: (deviceId) => {
          trace.push(`keychain delete ${deviceId}`);
          return failDelete
            ? Effect.fail(new KeychainUnavailable({ message: "keychain is locked" }))
            : Effect.sync(() => {
                items.delete(deviceId);
              });
        }
      })
    );
    const platform: TestPlatform = {
      ...setup.platform,
      env: { ...setup.platform.env, PATH: "/usr/bin:/bin", SNORLAX_HOME: setup.dataDir }
    };
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
              fakeScheduler(calls, { jobFile: join(setup.home, "job") }),
              Layer.succeed(CliEnv, CliEnv.of({ stdout: out.sink, stderr: err.sink, colors: false })),
              secrets,
              Backend.layer(offlineFetch)
            )
          )
        )
      );
      return { exitCode: exit.exitCode, stdout: out.chunks.join(""), stderr: err.chunks.join("") };
    };
    return {
      setup,
      items,
      trace,
      calls,
      run,
      failDelete: (value: boolean) => {
        failDelete = value;
      },
      close: () => setup.remove()
    };
  };

  it("deletes the item and then the data directory", async () => {
    const harness = await start();
    try {
      expect((await harness.run(["refresh", "--json"])).exitCode).toBe(0);
      const deviceId = deviceIdOf(harness.setup.dataDir);
      harness.items.set(deviceId, "device-token");
      const removed = await harness.run(["uninstall", "--data", "--json"]);
      expect(removed.stderr).toBe("");
      expect(removed.exitCode).toBe(0);
      expect(z.parse(okSchema, JSON.parse(removed.stdout)).ok).toBe(true);
      expect(harness.trace).toEqual(["scheduler uninstall", `keychain delete ${deviceId}`]);
      expect(harness.items.has(deviceId)).toBe(false);
      expect(existsSync(harness.setup.dataDir)).toBe(false);
      expect(harness.calls.map((call) => call.operation)).toEqual(["uninstall"]);
    } finally {
      await harness.close();
    }
  });

  it("treats a missing item as success and still deletes the data directory", async () => {
    const harness = await start();
    try {
      expect((await harness.run(["refresh", "--json"])).exitCode).toBe(0);
      const deviceId = deviceIdOf(harness.setup.dataDir);
      const removed = await harness.run(["uninstall", "--data", "--json"]);
      expect(removed.exitCode).toBe(0);
      expect(harness.trace).toEqual(["scheduler uninstall", `keychain delete ${deviceId}`]);
      expect(existsSync(harness.setup.dataDir)).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it("keeps the data directory when the keychain delete fails, after the job is removed", async () => {
    const harness = await start();
    try {
      expect((await harness.run(["refresh", "--json"])).exitCode).toBe(0);
      const deviceId = deviceIdOf(harness.setup.dataDir);
      harness.items.set(deviceId, "device-token");
      harness.failDelete(true);
      const failed = await harness.run(["uninstall", "--data", "--json"]);
      expect(failed.exitCode).toBe(1);
      const error = z.parse(failureSchema, JSON.parse(failed.stdout)).error;
      expect(error.code).toBe("keychain");
      expect(error.message).toContain("the scheduled job is already removed");
      expect(error.message).toContain("the data directory was kept");
      expect(harness.items.get(deviceId)).toBe("device-token");
      expect(existsSync(join(harness.setup.dataDir, "ledger.db"))).toBe(true);
      expect(harness.trace).toEqual(["scheduler uninstall", `keychain delete ${deviceId}`]);
      expect(harness.calls.map((call) => call.operation)).toEqual(["uninstall"]);
    } finally {
      await harness.close();
    }
  });

  it("leaves the keychain item in place without --data", async () => {
    const harness = await start();
    try {
      expect((await harness.run(["refresh", "--json"])).exitCode).toBe(0);
      const deviceId = deviceIdOf(harness.setup.dataDir);
      harness.items.set(deviceId, "device-token");
      const removed = await harness.run(["uninstall", "--json"]);
      expect(removed.exitCode).toBe(0);
      expect(harness.trace).toEqual(["scheduler uninstall"]);
      expect(harness.items.get(deviceId)).toBe("device-token");
      expect(existsSync(join(harness.setup.dataDir, "ledger.db"))).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("skips the keychain when the data directory has no ledger", async () => {
    const harness = await start();
    try {
      const removed = await harness.run(["uninstall", "--data", "--json"]);
      expect(removed.exitCode).toBe(0);
      expect(harness.trace).toEqual(["scheduler uninstall"]);
      expect(existsSync(harness.setup.dataDir)).toBe(false);
    } finally {
      await harness.close();
    }
  });
});
