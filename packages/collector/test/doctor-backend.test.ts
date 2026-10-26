import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, readdir, readFile, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { doctorSchema, httpDeviceRegisterResponseSchema } from "@rivus/snorlax-protocol";
import { createApp } from "@rivus/snorlax-worker";
import { createSqliteD1 } from "@rivus/snorlax-worker/sqlite-d1";
import { Effect, Layer } from "effect";
import * as z from "zod/mini";
import { describe, expect, it } from "vite-plus/test";

import { Backend, type BackendFetch } from "../src/capabilities/backend/backend.ts";
import { KeychainUnavailable, Secrets } from "../src/capabilities/secrets/secrets.ts";
import { CliEnv } from "../src/cli/env.ts";
import { runCli } from "../src/cli/run.ts";
import { NodeFiles, SnorlaxPlatform } from "../src/modules/platform/platform.ts";
import { createRefreshSetup, type RefreshSetup, type TestPlatform } from "./fixtures/platform.ts";
import { fakeScheduler } from "./fixtures/scheduler.ts";

/**
 * `doctor`'s backend checks. The flow only observes: a missing ledger is not created, and a directory
 * without `logs/` is left byte for byte as it was. The Worker app runs in memory.
 */

const ADMIN = "doctor-admin-token";
const BASE = "https://snorlax.test";
const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const MIGRATION = readFileSync(
  fileURLToPath(new URL("../../worker/migrations/0001_init.sql", import.meta.url)),
  "utf8"
);

const deviceSchema = z.object({ device_id: z.string() });

const createCapture = () => {
  const chunks: string[] = [];
  return { chunks, sink: { write: (text: string): void => void chunks.push(text) } };
};

const hashTree = async (root: string): Promise<string> => {
  const hash = createHash("sha256");
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(dir, entry.name);
      const rel = relative(root, path).split(sep).join("/");
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        hash.update(`dir ${rel}\n`);
        await walk(path);
        continue;
      }
      hash.update(`file ${rel}\n`);
      hash.update(await readFile(path));
      hash.update("\n");
    }
  };
  await walk(root);
  return hash.digest("hex");
};

const listPaths = async (root: string): Promise<string[]> => {
  const paths: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await walk(path);
        continue;
      }
      paths.push(relative(root, path).split(sep).join("/"));
    }
  };
  await walk(root);
  return paths.sort();
};

interface Lab {
  readonly fetchImpl: BackendFetch;
  readonly requests: string[];
  readonly close: () => void;
}

const createLab = (): Lab => {
  const database = new DatabaseSync(":memory:");
  database.exec(MIGRATION);
  const app = createApp({ db: createSqliteD1(database), adminToken: ADMIN, now: () => NOW });
  const requests: string[] = [];
  const fetchImpl: BackendFetch = async (request) => {
    const text = request.method === "GET" || request.method === "DELETE" ? null : await request.text();
    requests.push(`${request.method} ${new URL(request.url).pathname}`);
    return app.fetch(
      new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: text ?? undefined,
        signal: request.signal
      })
    );
  };
  return { fetchImpl, requests, close: () => database.close() };
};

const deviceIdOf = (dataDir: string): string => {
  const db = new DatabaseSync(join(dataDir, "ledger.db"), { readOnly: true, timeout: 200 });
  try {
    return z.parse(deviceSchema, db.prepare("SELECT device_id FROM meta WHERE id = 0").get()).device_id;
  } finally {
    db.close();
  }
};

const unavailableSecrets = Layer.succeed(
  Secrets,
  Secrets.of({
    read: () => Effect.fail(new KeychainUnavailable({ message: "keychain is locked" })),
    store: () => Effect.fail(new KeychainUnavailable({ message: "keychain is locked" })),
    delete: () => Effect.fail(new KeychainUnavailable({ message: "keychain is locked" }))
  })
);

const runDoctor = async (setup: RefreshSetup, fetchImpl: BackendFetch, secrets: Layer.Layer<Secrets>) => {
  const out = createCapture();
  const err = createCapture();
  const env = { ...setup.platform.env, PATH: "/usr/bin:/bin", SNORLAX_HOME: setup.dataDir };
  const platform: TestPlatform = { ...setup.platform, env };
  const exit = await Effect.runPromise(
    Effect.flip(
      runCli(
        ["doctor", "--json"],
        Layer.mergeAll(
          Layer.succeed(SnorlaxPlatform, platform),
          NodeFiles.live,
          fakeScheduler([], { jobFile: join(setup.home, "job") }),
          Layer.succeed(CliEnv, CliEnv.of({ stdout: out.sink, stderr: err.sink, colors: false })),
          secrets,
          Backend.layer(fetchImpl)
        )
      )
    )
  );
  return {
    exitCode: exit.exitCode,
    doctor: z.parse(doctorSchema, JSON.parse(out.chunks.join(""))),
    stderr: err.chunks.join("")
  };
};

const check = (
  doctor: z.output<typeof doctorSchema>,
  id: string
): { id: string; status: string; detail: string } | undefined => doctor.checks.find((item) => item.id === id);

describe("doctor backend checks", () => {
  it("reports unpaired sync and writes nothing when config has no backend URL", async () => {
    const setup = await createRefreshSetup({ now: NOW });
    const lab = createLab();
    try {
      await chmod(setup.dataDir, 0o700);
      await writeFile(join(setup.dataDir, "config.json"), "{}\n");
      const before = await hashTree(setup.dataDir);
      const { exitCode, doctor, stderr } = await runDoctor(setup, lab.fetchImpl, Secrets.memory({}));
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(doctor.healthy).toBe(true);
      expect(check(doctor, "sync")).toEqual({ id: "sync", status: "ok", detail: "not paired; sync is off" });
      expect(
        doctor.checks.some((item) => item.id === "keychain" || item.id === "backend" || item.id === "devices")
      ).toBe(false);
      expect(lab.requests).toEqual([]);
      expect(await hashTree(setup.dataDir)).toBe(before);
      expect(existsSync(join(setup.dataDir, "ledger.db"))).toBe(false);
    } finally {
      lab.close();
      await setup.remove();
    }
  });

  it("reports a missing ledger without creating it, and does not call devices", async () => {
    const setup = await createRefreshSetup({ now: NOW });
    const lab = createLab();
    try {
      await chmod(setup.dataDir, 0o700);
      await writeFile(join(setup.dataDir, "config.json"), JSON.stringify({ backendUrl: BASE }) + "\n");
      const before = await hashTree(setup.dataDir);
      const { exitCode, doctor } = await runDoctor(setup, lab.fetchImpl, Secrets.memory({}));
      expect(exitCode).toBe(0);
      expect(doctor.healthy).toBe(false);
      expect(check(doctor, "keychain")).toEqual({
        id: "keychain",
        status: "error",
        detail: "the ledger does not exist, so the device token was not read"
      });
      expect(check(doctor, "devices")).toEqual({
        id: "devices",
        status: "error",
        detail: "GET /v1/devices was not called"
      });
      expect(check(doctor, "backend")?.status).toBe("ok");
      expect(lab.requests).toEqual(["GET /v1/health"]);
      expect(existsSync(join(setup.dataDir, "ledger.db"))).toBe(false);
      expect(await hashTree(setup.dataDir)).toBe(before);
    } finally {
      lab.close();
      await setup.remove();
    }
  });

  it("reports a missing token, an unavailable keychain, a down backend, a revoked token, and a healthy backend", async () => {
    const setup = await createRefreshSetup({ now: NOW });
    const lab = createLab();
    try {
      const platform: TestPlatform = {
        ...setup.platform,
        env: { ...setup.platform.env, PATH: "/usr/bin:/bin", SNORLAX_HOME: setup.dataDir }
      };
      const refreshed = await Effect.runPromise(
        Effect.flip(
          runCli(
            ["refresh", "--json"],
            Layer.mergeAll(
              Layer.succeed(SnorlaxPlatform, platform),
              NodeFiles.live,
              fakeScheduler([], { jobFile: join(setup.home, "job") }),
              Layer.succeed(CliEnv, CliEnv.of({ stdout: { write() {} }, stderr: { write() {} }, colors: false })),
              Secrets.memory({}),
              Backend.layer(lab.fetchImpl)
            )
          )
        )
      );
      expect(refreshed.exitCode).toBe(0);
      const deviceId = deviceIdOf(setup.dataDir);
      await writeFile(
        join(setup.dataDir, "config.json"),
        JSON.stringify({ backendUrl: BASE, deviceName: "Desk" }) + "\n"
      );
      const pathsBefore = await listPaths(setup.dataDir);

      const missing = await runDoctor(setup, lab.fetchImpl, Secrets.memory({}));
      expect(missing.exitCode).toBe(0);
      expect(missing.doctor.healthy).toBe(false);
      expect(check(missing.doctor, "keychain")).toEqual({
        id: "keychain",
        status: "error",
        detail: "the device token is missing; run `snorlax pair` again"
      });
      expect(check(missing.doctor, "devices")?.detail).toBe("GET /v1/devices was not called");

      const locked = await runDoctor(setup, lab.fetchImpl, unavailableSecrets);
      expect(locked.doctor.healthy).toBe(false);
      expect(check(locked.doctor, "keychain")).toEqual({
        id: "keychain",
        status: "error",
        detail: "keychain is locked"
      });
      expect(check(locked.doctor, "devices")?.status).toBe("error");

      const down = await runDoctor(setup, () => Promise.reject(new Error("connection refused")), Secrets.memory({}));
      expect(down.doctor.healthy).toBe(false);
      expect(check(down.doctor, "backend")?.status).toBe("error");
      expect(check(down.doctor, "backend")?.detail).toContain("connection refused");

      const revoked = await runDoctor(
        setup,
        lab.fetchImpl,
        Secrets.memory({}, new Map([[deviceId, "not-a-device-token"]]))
      );
      expect(revoked.exitCode).toBe(0);
      expect(revoked.doctor.healthy).toBe(false);
      expect(check(revoked.doctor, "devices")).toEqual({
        id: "devices",
        status: "error",
        detail: "the device was revoked or the token is not valid"
      });
      expect(check(revoked.doctor, "keychain")?.status).toBe("ok");
      expect(check(revoked.doctor, "backend")?.status).toBe("ok");

      const registered = await lab.fetchImpl(
        new Request(`${BASE}/v1/devices`, {
          method: "POST",
          headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
          body: JSON.stringify({ deviceId, name: "Desk" })
        })
      );
      const token = z.parse(httpDeviceRegisterResponseSchema, await registered.json()).deviceToken;
      const healthy = await runDoctor(setup, lab.fetchImpl, Secrets.memory({}, new Map([[deviceId, token]])));
      expect(healthy.exitCode).toBe(0);
      expect(healthy.stderr).toBe("");
      expect(healthy.doctor.healthy).toBe(true);
      expect(check(healthy.doctor, "keychain")?.status).toBe("ok");
      expect(check(healthy.doctor, "backend")).toEqual({
        id: "backend",
        status: "ok",
        detail: "GET /v1/health answered"
      });
      expect(check(healthy.doctor, "devices")).toEqual({
        id: "devices",
        status: "ok",
        detail: "GET /v1/devices answered"
      });
      expect(healthy.doctor.checks.map((item) => item.id)).toEqual([
        "node-version",
        "data-dir",
        "config",
        "schedule",
        "keychain",
        "backend",
        "devices"
      ]);
      expect(await listPaths(setup.dataDir)).toEqual(pathsBefore);
    } finally {
      lab.close();
      await setup.remove();
    }
  });
});
