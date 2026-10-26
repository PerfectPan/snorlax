import type { Platform } from "@rivus/agent-kit/platform";
import { Data, Duration, Effect } from "effect";
import * as z from "zod/mini";

import { errorMessage } from "../../core/error-message/error-message.ts";

/**
 * The keychain or secret service could not be run. A missing item is not this failure: `read` returns
 * undefined, and `snorlax pair` is what stores one (plan 3.4.2).
 */
export class KeychainUnavailable extends Data.TaggedError("KeychainUnavailable")<{
  readonly message: string;
}> {}

/**
 * The store tool's program does not exist (`ENOENT`). No item can be stored, so `read` and `delete` treat it
 * as an absent item. `store` still fails: pairing needs the program.
 */
export class StoreBinaryMissing extends Data.TaggedError("StoreBinaryMissing")<{
  readonly message: string;
}> {}

/** Node's spawn error carries `code`. A hand-written shape check would duplicate this schema. */
const enoentSchema = z.object({ code: z.literal("ENOENT") });

const isEnoent = (error: unknown): boolean => z.safeParse(enoentSchema, error).success;

const missingBinary = (command: string): StoreBinaryMissing =>
  new StoreBinaryMissing({ message: `cannot run ${command}: the program does not exist` });

/** `read` and `delete` answer "no item" when the program is missing. */
export const absentWhenBinaryMissing = <A>(
  effect: Effect.Effect<A, KeychainUnavailable | StoreBinaryMissing>,
  absent: A
): Effect.Effect<A, KeychainUnavailable> =>
  effect.pipe(Effect.catchTag("StoreBinaryMissing", () => Effect.succeed(absent)));

/** `store` stays a failure when the program is missing. The message names the path and not a secret. */
export const unavailableWhenBinaryMissing = <A>(
  effect: Effect.Effect<A, KeychainUnavailable | StoreBinaryMissing>
): Effect.Effect<A, KeychainUnavailable> =>
  effect.pipe(
    Effect.catchTag("StoreBinaryMissing", (error) => Effect.fail(new KeychainUnavailable({ message: error.message })))
  );

/** How long one keychain command may run, on the Effect clock, before the child is stopped. */
const COMMAND_TIMEOUT = Duration.seconds(15);

type CommandPlatform = Pick<Platform, "env" | "home" | "process">;

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const decode = (chunks: readonly Uint8Array[]): string => {
  let length = 0;
  for (const chunk of chunks) {
    length += chunk.byteLength;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
};

const readAll = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array[]> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const next = await reader.read();
    if (next.done) {
      return chunks;
    }
    chunks.push(next.value);
  }
};

const cannotRun = (command: string, error: unknown): KeychainUnavailable =>
  new KeychainUnavailable({ message: `cannot run ${command}: ${errorMessage(error)}` });

/**
 * Runs `command` with `args` and writes `stdin` to the child, then closes it. The token a caller puts in
 * `stdin` is never placed in `args` (plan 3.4.2). `ENOENT` is `StoreBinaryMissing`: the program is not
 * installed, so no item exists. Any other failure to start, a signal, or no answer within 15s on the Effect
 * clock is `KeychainUnavailable`. A non-zero exit is still a result, because "not found" is an exit code the
 * caller knows and a broken keychain is a different one.
 */
export const runStdinCommand = (
  platform: CommandPlatform,
  command: string,
  args: readonly string[],
  stdin: string
): Effect.Effect<CommandResult, KeychainUnavailable | StoreBinaryMissing> =>
  // `spawn` throws synchronously for ENOEXEC, ENOTDIR and E2BIG, and `Writable.toWeb` (reached by
  // `getWriter`) throws EMFILE. A throw inside `Effect.callback` is a defect, so refresh would fail
  // `internal` and skip the snapshot. `Effect.try` keeps it on the failure channel. `ENOENT` arrives on
  // `exited` when the program is not there; the synchronous path handles it too.
  Effect.try({
    try: () => {
      const controller = new AbortController();
      try {
        const child = platform.process.spawn(command, args, {
          cwd: platform.home,
          env: platform.env,
          signal: controller.signal
        });
        return { controller, child, writer: child.stdin.getWriter() };
      } catch (error) {
        controller.abort();
        throw error;
      }
    },
    catch: (error) => (isEnoent(error) ? missingBinary(command) : cannotRun(command, error))
  }).pipe(
    Effect.flatMap(({ controller, child, writer }) =>
      Effect.callback<CommandResult, KeychainUnavailable | StoreBinaryMissing>((resume) => {
        const encoder = new TextEncoder();
        const written = (async (): Promise<void> => {
          try {
            await writer.write(encoder.encode(stdin));
            await writer.close();
          } catch {
            // The child can exit before it reads; its status is the result that matters.
          }
        })();
        const finished = Promise.all([readAll(child.stdout), readAll(child.stderr), child.exited, written]).then(
          ([stdout, stderr, status]) => ({ stdout: decode(stdout), stderr: decode(stderr), status })
        );
        let settled = false;
        const finish = (effect: Effect.Effect<CommandResult, KeychainUnavailable | StoreBinaryMissing>): void => {
          if (!settled) {
            settled = true;
            resume(effect);
          }
        };
        void finished.then(
          ({ stdout, stderr, status }) => {
            if (status.signal !== null || status.code === null) {
              finish(
                Effect.fail(
                  new KeychainUnavailable({
                    message: `${command} stopped (${status.signal ?? "no exit code"})`
                  })
                )
              );
              return;
            }
            finish(Effect.succeed({ code: status.code, stdout, stderr }));
          },
          (error: unknown) => finish(Effect.fail(isEnoent(error) ? missingBinary(command) : cannotRun(command, error)))
        );
        return Effect.sync(() => controller.abort());
      }).pipe(
        Effect.timeoutOrElse({
          duration: COMMAND_TIMEOUT,
          orElse: () => Effect.fail(new KeychainUnavailable({ message: `${command} did not finish within 15s` }))
        })
      )
    )
  );

/** `SNORLAX_SECURITY` or `SNORLAX_SECRET_TOOL` when set, otherwise the system binary. */
export const commandPath = (
  env: Platform["env"],
  name: "SNORLAX_SECURITY" | "SNORLAX_SECRET_TOOL",
  fallback: string
): string => {
  const override = env[name];
  if (override === undefined || override === "") {
    return fallback;
  }
  return override;
};

/** The last non-empty line a tool printed. A successful read is that line; the tools add a trailing newline. */
export const lastLine = (stdout: string): string => {
  const lines = stdout.split("\n").filter((line) => line !== "");
  return lines.at(-1) ?? "";
};
