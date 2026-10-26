import type { Platform } from "@rivus/agent-kit/platform";
import { Data, Duration, Effect } from "effect";

import { errorMessage } from "../../core/error-message/error-message.ts";

/**
 * The keychain or secret service could not be run. A missing item is not this failure: `read` returns
 * undefined, and `snorlax pair` is what stores one (plan 3.4.2).
 */
export class KeychainUnavailable extends Data.TaggedError("KeychainUnavailable")<{
  readonly message: string;
}> {}

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

/**
 * Runs `command` with `args` and writes `stdin` to the child, then closes it. The token a caller puts in
 * `stdin` is never placed in `args` (plan 3.4.2). Failing to start, a signal, or no answer within 15s on the
 * Effect clock is `KeychainUnavailable`; a non-zero exit is still a result, because "not found" is an exit
 * code the caller knows and a broken keychain is a different one.
 */
export const runStdinCommand = (
  platform: CommandPlatform,
  command: string,
  args: readonly string[],
  stdin: string
): Effect.Effect<CommandResult, KeychainUnavailable> =>
  Effect.callback<CommandResult, KeychainUnavailable>((resume) => {
    const controller = new AbortController();
    const child = platform.process.spawn(command, args, {
      cwd: platform.home,
      env: platform.env,
      signal: controller.signal
    });
    const encoder = new TextEncoder();
    const written = (async (): Promise<void> => {
      const writer = child.stdin.getWriter();
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
    const finish = (effect: Effect.Effect<CommandResult, KeychainUnavailable>): void => {
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
      (error: unknown) =>
        finish(Effect.fail(new KeychainUnavailable({ message: `cannot run ${command}: ${errorMessage(error)}` })))
    );
    return Effect.sync(() => controller.abort());
  }).pipe(
    Effect.timeoutOrElse({
      duration: COMMAND_TIMEOUT,
      orElse: () => Effect.fail(new KeychainUnavailable({ message: `${command} did not finish within 15s` }))
    })
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
