import { mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";

/**
 * Generators for agent fixture logs under a temporary home, with the shapes the kit's decoders read (learned
 * from `@rivus/agent-kit`'s own dist sources; no real agent log is ever read or copied — AGENTS.md). Every
 * writer pins the file's mtime (one hour before the scan's clock by default), so the kit decodes it as
 * `final`: a quiet source reports its still-open requests at once.
 */

/** Token counts in the kit's convention: `inputTokens` includes cache reads and writes, `outputTokens` reasoning. */
export interface UsageCounts {
  readonly inputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly cacheWrite1hTokens?: number;
  readonly outputTokens: number;
  readonly reasoningTokens?: number;
}

/** The default fixture mtime: quiet (past the kit's 30-minute window) but recent enough to be listed. */
export const quietMtime = (nowMs: number): number => nowMs - 3_600_000;

const iso = (ms: number): string => new Date(ms).toISOString();

const writeLines = async (path: string, lines: readonly unknown[], mtimeMs: number): Promise<string> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, lines.map((line) => `${JSON.stringify(line)}\n`).join(""), "utf8");
  await utimes(path, new Date(mtimeMs), new Date(mtimeMs));
  return path;
};

/** Claude Code writes `input_tokens` without the cache, so the cache counts are subtracted back out. */
const claudeUsage = (usage: UsageCounts): Record<string, unknown> => {
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  return {
    input_tokens: usage.inputTokens - cacheRead - cacheWrite,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
    output_tokens: usage.outputTokens,
    ...(usage.reasoningTokens === undefined
      ? {}
      : { output_tokens_details: { thinking_tokens: usage.reasoningTokens } })
  };
};

export interface ClaudeFixtureRequest {
  readonly requestId: string;
  readonly model: string;
  readonly timestampMs: number;
  readonly usage: UsageCounts;
  /** Defaults to the session file's own session id. */
  readonly sessionId?: string;
}

export interface ClaudeSessionFixture {
  readonly sessionId: string;
  readonly project?: string;
  /** When set, the file is a subagent transcript: `<project>/<sessionId>/subagents/agent-<subagent>.jsonl`. */
  readonly subagent?: string;
  readonly requests: readonly ClaudeFixtureRequest[];
  readonly mtimeMs?: number;
}

const claudeLine = (request: ClaudeFixtureRequest, sessionId: string): Record<string, unknown> => ({
  type: "assistant",
  timestamp: iso(request.timestampMs),
  sessionId,
  requestId: request.requestId,
  message: { id: `msg_${request.requestId}`, model: request.model, usage: claudeUsage(request.usage) }
});

export async function writeClaudeSession(home: string, fixture: ClaudeSessionFixture): Promise<string> {
  const project = fixture.project ?? "-Users-tester-fixture";
  const path = fixture.subagent
    ? join(home, ".claude", "projects", project, fixture.sessionId, "subagents", `agent-${fixture.subagent}.jsonl`)
    : join(home, ".claude", "projects", project, `${fixture.sessionId}.jsonl`);
  return writeLines(
    path,
    fixture.requests.map((request) => claudeLine(request, request.sessionId ?? fixture.sessionId)),
    fixture.mtimeMs ?? quietMtime(Date.now())
  );
}

/** Appends requests to an existing session file and re-pins its mtime, as an agent writing more turns. */
export async function appendClaudeRequests(
  path: string,
  requests: readonly ClaudeFixtureRequest[],
  sessionId: string,
  mtimeMs = quietMtime(Date.now())
): Promise<void> {
  const existing = await readFile(path, "utf8");
  await writeFile(
    path,
    existing + requests.map((request) => `${JSON.stringify(claudeLine(request, sessionId))}\n`).join(""),
    "utf8"
  );
  await utimes(path, new Date(mtimeMs), new Date(mtimeMs));
}

/** Codex reports `input_tokens` already including cached input, the kit's convention as it is. */
const codexUsage = (usage: UsageCounts): Record<string, unknown> => ({
  input_tokens: usage.inputTokens,
  cached_input_tokens: usage.cacheReadTokens ?? 0,
  cache_write_input_tokens: usage.cacheWriteTokens ?? 0,
  output_tokens: usage.outputTokens,
  reasoning_output_tokens: usage.reasoningTokens ?? 0,
  total_tokens: usage.inputTokens + usage.outputTokens
});

export interface CodexRolloutFixture {
  /** The rollout file name; defaults under `sessions/2026/10/22/`. */
  readonly file?: string;
  readonly sessionId: string;
  readonly model: string;
  readonly requests: readonly { responseId: string; timestampMs: number; usage: UsageCounts }[];
  readonly mtimeMs?: number;
}

export async function writeCodexRollout(home: string, fixture: CodexRolloutFixture): Promise<string> {
  const first = fixture.requests[0];
  if (first === undefined) {
    throw new Error("a codex rollout fixture needs at least one request");
  }
  const path = join(
    home,
    ".codex",
    fixture.file ?? join("sessions", "2026", "10", "22", `rollout-${fixture.sessionId}.jsonl`)
  );
  return writeLines(
    path,
    [
      { timestamp: iso(first.timestampMs - 60_000), type: "session_meta", payload: { id: fixture.sessionId } },
      { timestamp: iso(first.timestampMs - 30_000), type: "turn_context", payload: { model: fixture.model } },
      ...fixture.requests.map((request) => ({
        timestamp: iso(request.timestampMs),
        type: "token_usage_record",
        payload: { response_id: request.responseId, usage: codexUsage(request.usage) }
      }))
    ],
    fixture.mtimeMs ?? quietMtime(Date.now())
  );
}

export interface PiSessionFixture {
  readonly sessionId: string;
  readonly entries: readonly {
    entryId: string;
    model: string;
    timestampMs: number;
    usage: UsageCounts;
    /** Pi's own logged cost for the message, kept by the kit even when 0 (Spec S12). */
    costUsd: number;
  }[];
  readonly mtimeMs?: number;
}

/** Pi counts `input` without the cache, like Claude Code; the kit adds the cache back into `inputTokens`. */
export async function writePiSession(home: string, fixture: PiSessionFixture): Promise<string> {
  const first = fixture.entries[0];
  if (first === undefined) {
    throw new Error("a pi session fixture needs at least one entry");
  }
  const path = join(home, ".pi", "agent", "sessions", `2026-10-22T09-15-00_${fixture.sessionId}.jsonl`);
  return writeLines(
    path,
    [
      { id: fixture.sessionId, type: "session", timestamp: iso(first.timestampMs - 60_000) },
      ...fixture.entries.map((entry) => ({
        id: entry.entryId,
        type: "message",
        timestamp: iso(entry.timestampMs),
        message: {
          role: "assistant",
          model: entry.model,
          provider: "fixture",
          responseId: `resp_${entry.entryId}`,
          usage: {
            input: entry.usage.inputTokens - (entry.usage.cacheReadTokens ?? 0) - (entry.usage.cacheWriteTokens ?? 0),
            output: entry.usage.outputTokens - (entry.usage.reasoningTokens ?? 0),
            cacheRead: entry.usage.cacheReadTokens ?? 0,
            cacheWrite: entry.usage.cacheWriteTokens ?? 0,
            reasoning: entry.usage.reasoningTokens ?? 0,
            totalTokens: entry.usage.inputTokens + entry.usage.outputTokens,
            cost: { total: entry.costUsd }
          }
        }
      }))
    ],
    fixture.mtimeMs ?? quietMtime(Date.now())
  );
}

export interface GrokTurnFixture {
  readonly promptId: string;
  readonly timestampMs: number;
  /** The turn's own totals, as Grok reports them per turn; the model split below must add up to them. */
  readonly usage: UsageCounts;
  readonly modelCalls: number;
  /** Grok's `costUsdTicks`: 10^10 ticks per USD; absent on a model without a logged cost. */
  readonly costUsdTicks?: number;
  readonly modelUsage?: Readonly<
    Record<
      string,
      {
        usage: UsageCounts;
        modelCalls: number;
        costUsdTicks?: number;
      }
    >
  >;
  readonly mtimeMs?: number;
}

export interface GrokSessionFixture {
  readonly sessionId: string;
  readonly model: string;
  readonly turns: readonly GrokTurnFixture[];
  readonly mtimeMs?: number;
}

/** Grok's own count names map one to one onto the kit's usage; a turn may carry a per-model split. */
export async function writeGrokSession(home: string, fixture: GrokSessionFixture): Promise<string> {
  const path = join(home, ".grok", "sessions", fixture.sessionId, "updates.jsonl");
  return writeLines(
    path,
    fixture.turns.map((turn, index) => ({
      timestamp: iso(turn.timestampMs),
      update: {
        sessionUpdate: "turn_completed",
        prompt_id: turn.promptId,
        _meta: { promptIndex: index, modelId: fixture.model },
        usage: {
          inputTokens: turn.usage.inputTokens,
          outputTokens: turn.usage.outputTokens,
          totalTokens: turn.usage.inputTokens + turn.usage.outputTokens,
          cachedReadTokens: turn.usage.cacheReadTokens ?? 0,
          cacheCreationTokens: turn.usage.cacheWriteTokens ?? 0,
          reasoningTokens: turn.usage.reasoningTokens ?? 0,
          modelCalls: turn.modelCalls,
          ...(turn.costUsdTicks === undefined ? {} : { costUsdTicks: turn.costUsdTicks }),
          ...(turn.modelUsage === undefined
            ? {}
            : {
                modelUsage: Object.fromEntries(
                  Object.entries(turn.modelUsage).map(([model, share]) => [
                    model,
                    {
                      inputTokens: share.usage.inputTokens,
                      outputTokens: share.usage.outputTokens,
                      totalTokens: share.usage.inputTokens + share.usage.outputTokens,
                      cachedReadTokens: share.usage.cacheReadTokens ?? 0,
                      cacheCreationTokens: share.usage.cacheWriteTokens ?? 0,
                      reasoningTokens: share.usage.reasoningTokens ?? 0,
                      modelCalls: share.modelCalls,
                      ...(share.costUsdTicks === undefined ? {} : { costUsdTicks: share.costUsdTicks })
                    }
                  ])
                )
              })
        }
      }
    })),
    fixture.mtimeMs ?? quietMtime(Date.now())
  );
}

export interface OpencodeMessageFixture {
  readonly messageId: string;
  readonly sessionId: string;
  readonly model: string;
  readonly timestampMs: number;
  readonly usage: UsageCounts;
  /** opencode logs each message's cost itself; the kit keeps it as the agent's (Spec S12). */
  readonly costUsd: number;
}

/** opencode keeps a `message` table in `opencode.db` under its data home; `time` is epoch milliseconds. */
export async function writeOpencodeDatabase(
  opencodeHome: string,
  messages: readonly OpencodeMessageFixture[],
  mtimeMs = quietMtime(Date.now())
): Promise<string> {
  await mkdir(opencodeHome, { recursive: true });
  const path = join(opencodeHome, "opencode.db");
  await rm(path, { force: true });
  const db = new DatabaseSync(path);
  try {
    db.exec(
      "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)"
    );
    const insert = db.prepare(
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)"
    );
    for (const message of [...messages].sort((a, b) => a.timestampMs - b.timestampMs)) {
      const cacheRead = message.usage.cacheReadTokens ?? 0;
      const cacheWrite = message.usage.cacheWriteTokens ?? 0;
      const reasoning = message.usage.reasoningTokens ?? 0;
      insert.run(
        message.messageId,
        message.sessionId,
        message.timestampMs,
        message.timestampMs,
        JSON.stringify({
          id: message.messageId,
          role: "assistant",
          sessionID: message.sessionId,
          modelID: message.model,
          providerID: "fixture",
          cost: message.costUsd,
          time: { created: message.timestampMs, completed: message.timestampMs },
          tokens: {
            input: message.usage.inputTokens - cacheRead - cacheWrite,
            output: message.usage.outputTokens - reasoning,
            reasoning,
            total: message.usage.inputTokens + message.usage.outputTokens,
            cache: { read: cacheRead, write: cacheWrite }
          }
        })
      );
    }
  } finally {
    db.close();
  }
  await utimes(path, new Date(mtimeMs), new Date(mtimeMs));
  return path;
}
