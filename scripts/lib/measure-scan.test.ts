import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";

import { createNodePlatform } from "@rivus/agent-kit/node";
import * as z from "zod/mini";
import { expect, it } from "vite-plus/test";

import { measureScan } from "./measure-scan.ts";

/** Older than the kit's 30-minute quiet window, and inside the incremental scan's 2-hour `since`. */
const QUIET_MS = 31 * 60 * 1000;

/** Shared by paths, prompts, model names and session ids, so a leak of any of them fails the stdout check. */
const SENTINEL = "sentinel-7f3a9c";

const AGENT_HOME_ENV = [
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "GEMINI_CLI_HOME",
  "GROK_HOME",
  "XDG_DATA_HOME",
  "PI_CODING_AGENT_DIR"
] as const;

const APPEND_RECORDS = 3;

const whole = z.int().check(z.nonnegative());
const failureCounts = z.record(z.string(), whole);
const phaseSchema = z.strictObject({
  phase: z.enum(["full", "incremental"]),
  records: whole,
  sources: whole,
  decodeFailures: failureCounts,
  sourceFailures: failureCounts,
  durationMs: whole,
  peakRssBytes: whole,
  stateBytes: whole
});
const reportSchema = z.strictObject({
  phases: z.tuple([phaseSchema, phaseSchema])
});

function recordTime(): string {
  return new Date(Date.now() - QUIET_MS).toISOString();
}

function claudeAssistant(requestId: string, sessionId: string): string {
  return JSON.stringify({
    type: "assistant",
    requestId,
    sessionId,
    timestamp: recordTime(),
    message: {
      id: `msg-${requestId}`,
      model: `model-${SENTINEL}`,
      usage: { input_tokens: 10, output_tokens: 4 }
    }
  });
}

function codexUsage(responseId: string): string {
  const timestamp = recordTime();
  return JSON.stringify({
    type: "token_usage_record",
    timestamp,
    payload: {
      response_id: responseId,
      usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
      timestamp
    }
  });
}

interface Fixture {
  readonly home: string;
  readonly claudeFile: string;
  readonly sessionId: string;
}

function touchQuiet(path: string): void {
  const mtime = new Date(Date.now() - QUIET_MS);
  utimesSync(path, mtime, mtime);
}

function writeQuiet(path: string, lines: readonly string[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${lines.join("\n")}\n`);
  touchQuiet(path);
}

/** Claude Code and Codex logs under `home`, each with one usage record. File mtimes sit in the quiet window. */
function writeFixture(home: string): Fixture {
  const sessionId = `session-${SENTINEL}`;
  const claudeFile = join(home, ".claude", "projects", `proj-${SENTINEL}`, `${sessionId}.jsonl`);
  const codexFile = join(home, ".codex", "sessions", `rollout-${SENTINEL}.jsonl`);
  mkdirSync(join(home, ".codex", "archived_sessions"), { recursive: true });
  const prompt = `prompt ${SENTINEL} do not print`;
  writeQuiet(claudeFile, [
    JSON.stringify({
      type: "user",
      sessionId,
      timestamp: recordTime(),
      message: { role: "user", content: prompt }
    }),
    claudeAssistant(`req-${SENTINEL}-0`, sessionId)
  ]);
  writeQuiet(codexFile, [
    JSON.stringify({
      type: "session_meta",
      timestamp: recordTime(),
      payload: { id: sessionId, timestamp: recordTime() }
    }),
    JSON.stringify({
      type: "turn_context",
      timestamp: recordTime(),
      payload: { model: `model-${SENTINEL}`, turn_id: `turn-${SENTINEL}` }
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: recordTime(),
      payload: { type: "user_message", message: prompt }
    }),
    codexUsage(`resp-${SENTINEL}-0`)
  ]);
  return { home, claudeFile, sessionId };
}

function appendRecords(fixture: Fixture, count: number): void {
  const lines = Array.from({ length: count }, (_, index) =>
    claudeAssistant(`req-${SENTINEL}-${index + 1}`, fixture.sessionId)
  );
  appendFileSync(fixture.claudeFile, `${lines.join("\n")}\n`);
  touchQuiet(fixture.claudeFile);
}

/** Drops agent-home overrides so a scan cannot leave the temporary home. */
function isolatedEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  for (const key of AGENT_HOME_ENV) {
    delete env[key];
  }
  return env;
}

async function withTempHome<T>(run: (home: string) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "snorlax-measure-scan-"));
  try {
    return await run(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function assertNoSecrets(text: string, home: string): void {
  expect(text.includes(home)).toBe(false);
  expect(text.includes(SENTINEL)).toBe(false);
}

it("prints counts for a full scan and a quiet incremental scan, without fixture secrets", async () => {
  await withTempHome(async (home) => {
    writeFixture(home);
    const result = spawnSync(process.execPath, [join(import.meta.dirname, "../measure-scan.ts")], {
      env: isolatedEnv(home),
      encoding: "utf8"
    });
    expect(result.status).toBe(0);
    assertNoSecrets(result.stdout, home);
    assertNoSecrets(result.stderr, home);

    const parsed = reportSchema.safeParse(JSON.parse(result.stdout));
    if (!parsed.success) {
      throw new Error(z.prettifyError(parsed.error));
    }
    const [full, incremental] = parsed.data.phases;
    expect(full.phase).toBe("full");
    expect(incremental.phase).toBe("incremental");
    expect(full.records).toBe(2);
    expect(incremental.records).toBe(0);
    expect(full.decodeFailures["claude-code"]).toBeUndefined();
    expect(full.decodeFailures.codex).toBeUndefined();
    expect(full.sourceFailures["claude-code"]).toBeUndefined();
    expect(full.sourceFailures.codex).toBeUndefined();
  });
});

it("counts exactly the records appended between the full scan and the incremental scan", async () => {
  await withTempHome(async (home) => {
    const fixture = writeFixture(home);
    const report = await measureScan(createNodePlatform({ home, env: { HOME: home } }), {
      betweenPhases: () => {
        appendRecords(fixture, APPEND_RECORDS);
      }
    });
    expect(report.phases[0].records).toBe(2);
    expect(report.phases[1].records).toBe(APPEND_RECORDS);
    expect(report.phases[1].decodeFailures["claude-code"]).toBeUndefined();
    expect(report.phases[1].decodeFailures.codex).toBeUndefined();
    assertNoSecrets(JSON.stringify(report), home);
  });
});
