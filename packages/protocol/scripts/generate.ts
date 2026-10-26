import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as z from "zod/mini";

import * as protocol from "../src/index.ts";

/**
 * The protocol build: exports every schema as JSON Schema (`schema/*.json`) and writes one sample document
 * per shape (`fixtures/*.json`). Both directories are committed; Batch 4's Swift tests decode the fixtures
 * and CI fails when regeneration changes either output, so this script must stay deterministic.
 */

const packageRoot = dirname(fileURLToPath(import.meta.url)) + "/..";

const total = (tokens: number, requests: number, sessions: number, costUsd: number): protocol.WindowTotal => ({
  tokens,
  inputTokens: Math.floor(tokens * 0.9),
  outputTokens: tokens - Math.floor(tokens * 0.9),
  cacheReadTokens: Math.floor(tokens * 0.8),
  costUsd,
  requests,
  sessions,
  unpricedRequests: 0
});

const today = total(81_234_567, 2210, 41, 312.4);
const last7d = total(412_345_678, 11_204, 167, 1583.2);
const last30d = total(1_612_345_678, 43_881, 703, 6190.7);

const sampleBucket: protocol.Bucket = {
  deviceId: "6f1c8d2e-4a3b-4c5d-9e6f-7a8b9c0d1e2f",
  hour: Math.floor(Date.UTC(2026, 9, 22, 9) / 1000),
  agent: "claude-code",
  model: "claude-opus-5-5",
  inputTokens: 80_100_000,
  cacheReadTokens: 76_000_000,
  cacheWriteTokens: 2_400_000,
  outputTokens: 11_345,
  reasoningTokens: 8_120,
  requests: 2210,
  sessionsStarted: 41,
  costUsd: 312.4,
  unpricedRequests: 0
};

const sampleSnapshot: protocol.Snapshot = {
  schemaVersion: 1,
  generatedAt: "2026-10-23T02:35:12.482Z",
  timeZone: "Asia/Shanghai",
  totals: { today, last7d, last30d },
  byAgent: [
    { agent: "claude-code", today, last7d, last30d },
    {
      agent: "codex",
      today: total(12_345_678, 310, 6, 41.8),
      last7d: total(88_888_888, 1904, 33, 260.1),
      last30d: total(301_234_567, 7420, 121, 890.5)
    }
  ],
  byModel: [
    { model: "claude-opus-5-5", today, last7d, last30d },
    {
      model: "gpt-6.2",
      today: total(12_345_678, 310, 6, 41.8),
      last7d: total(88_888_888, 1904, 33, 260.1),
      last30d: total(301_234_567, 7420, 121, 890.5)
    }
  ],
  byDevice: [
    {
      deviceId: "6f1c8d2e-4a3b-4c5d-9e6f-7a8b9c0d1e2f",
      name: "MacBook Pro",
      isThisDevice: true,
      lastPushAt: "2026-10-23T02:35:11.901Z",
      today,
      last7d,
      last30d
    },
    {
      deviceId: "0b2a4d6c-8e9f-4a1b-b3c5-d7e9f0a1b2c3",
      name: "Mac mini",
      isThisDevice: false,
      lastPushAt: "2026-10-23T02:34:41.117Z",
      today: total(2_400_000, 96, 2, 9.6),
      last7d: total(18_000_000, 731, 15, 71.2),
      last30d: total(64_000_000, 2604, 58, 255.9)
    }
  ],
  daily: [
    { date: "2026-09-24", tokens: 41_234_567, costUsd: 160.2 },
    { date: "2026-10-22", tokens: 81_234_567, costUsd: 312.4 },
    { date: "2026-10-23", tokens: 12_345_678, costUsd: 41.8 }
  ],
  hourlyToday: [
    { hour: "2026-10-23T09:00:00+08:00", tokens: 9_812_345 },
    { hour: "2026-10-23T10:00:00+08:00", tokens: 2_533_333 }
  ],
  status: {
    lastScanAt: "2026-10-23T02:35:10.205Z",
    sync: { state: "ok", at: "2026-10-23T02:35:11.901Z" },
    failuresByAgent: { grok: 2 },
    paired: true
  }
};

const sampleStatus: protocol.Status = {
  schemaVersion: 1,
  ok: true,
  version: "0.1.0",
  dataDir: "~/Library/Application Support/snorlax",
  device: { id: "6f1c8d2e-4a3b-4c5d-9e6f-7a8b9c0d1e2f", name: "MacBook Pro" },
  lastScanAt: "2026-10-23T02:35:10.205Z",
  sync: { state: "ok", at: "2026-10-23T02:35:11.901Z" },
  failuresByAgent: { grok: 2 },
  pricingChanged: false,
  agents: [
    { agent: "claude-code", displayName: "Claude Code", status: "found" },
    { agent: "codex", displayName: "Codex CLI", status: "found" },
    { agent: "cursor", displayName: "Cursor", status: "missing" }
  ]
};

const sampleDoctor: protocol.Doctor = {
  schemaVersion: 1,
  ok: true,
  healthy: true,
  checks: [
    { id: "node-version", status: "ok", detail: "Node v24.11.0 satisfies >= 22.13" },
    { id: "data-dir", status: "ok", detail: "~/Library/Application Support/snorlax is a directory with mode 0700" },
    { id: "config", status: "ok", detail: "config.json parses" }
  ]
};

const schemas: Readonly<Record<string, z.core.$ZodType>> = {
  bucket: protocol.bucketSchema,
  snapshot: protocol.snapshotSchema,
  "snapshot-output": protocol.snapshotOutputSchema,
  ok: protocol.okSchema,
  failure: protocol.failureSchema,
  "refresh-result": protocol.refreshResultSchema,
  "pair-result": protocol.pairResultSchema,
  status: protocol.statusSchema,
  doctor: protocol.doctorSchema,
  "uninstall-result": protocol.uninstallResultSchema
};

const fixtures: Readonly<Record<string, unknown>> = {
  bucket: sampleBucket,
  snapshot: sampleSnapshot,
  "snapshot-output": { schemaVersion: 1, ok: true, snapshot: sampleSnapshot },
  ok: { schemaVersion: 1, ok: true },
  failure: {
    schemaVersion: 1,
    ok: false,
    error: { code: "data-dir", message: "the data directory is not writable: ~/Library/Application Support/snorlax" }
  },
  "refresh-result": {
    schemaVersion: 1,
    ok: true,
    scannedAt: "2026-10-23T02:35:10.205Z",
    records: 412,
    failures: 0,
    sync: { ok: true, pushed: 9, pulled: 23 }
  },
  "pair-result": {
    schemaVersion: 1,
    ok: true,
    deviceId: "6f1c8d2e-4a3b-4c5d-9e6f-7a8b9c0d1e2f",
    name: "MacBook Pro"
  },
  status: sampleStatus,
  doctor: sampleDoctor,
  "uninstall-result": { schemaVersion: 1, ok: true, keptEntries: ["logs/notes.txt", "photos"] }
};

async function writeGenerated(subdir: string, documents: Readonly<Record<string, unknown>>): Promise<number> {
  await mkdir(join(packageRoot, subdir), { recursive: true });
  for (const [name, document] of Object.entries(documents).sort(([a], [b]) => a.localeCompare(b))) {
    await writeFile(join(packageRoot, subdir, `${name}.json`), `${JSON.stringify(document, null, 2)}\n`, "utf8");
  }
  return Object.keys(documents).length;
}

const schemaCount = await writeGenerated(
  "schema",
  Object.fromEntries(Object.entries(schemas).map(([name, schema]) => [name, z.toJSONSchema(schema)]))
);
const fixtureCount = await writeGenerated("fixtures", fixtures);
console.log(`protocol: wrote ${schemaCount} JSON Schema files and ${fixtureCount} fixtures`);
