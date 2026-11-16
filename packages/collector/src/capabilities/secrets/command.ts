import type { Platform } from "@rivus/agent-kit/platform";
import { Data, Duration, Effect } from "effect";
import * as z from "zod/mini";

import { errorMessage } from "../../core/error-message/error-message.ts";
import { decodeChunks, readAllChunks } from "../../modules/read-text-file/read-text-file.ts";

/**
 * The keychain or secret service could not be run. A missing item is not this failure: `read` returns
 * undefined, and `snorlax pair` is what stores one.
 */
export class KeychainUnavailable extends Data.TaggedError("KeychainUnavailable")<{
  readonly message: string;
}> {}

/**
 * The store tool's program does not exist (`ENOENT`). An item stored earlier can still be in the keychain:
 * the tool may have been removed after pairing, or the configured path may have changed. `read` and `delete`
 * surface this instead of answering "no item". `store` still fails: pairing needs the program.
 */
export class StoreBinaryMissing extends Data.TaggedError("StoreBinaryMissing")<{
  readonly message: string;
  /** The path that could not be started. The notice names it and does not name a token. */
  readonly command: string;
}> {}

/** Node's spawn error carries `code`. A hand-written shape check would duplicate this schema. */
const enoentSchema = z.object({ code: z.literal("ENOENT") });

const isEnoent = (error: unknown): boolean => z.safeParse(enoentSchema, error).success;

const missingBinary = (command: string): StoreBinaryMissing =>
  new StoreBinaryMissing({ command, message: `cannot run ${command}: the program does not exist` });

/**
 * What `unpair`, `uninstall --data`, `doctor` and a paired refresh say when the program cannot be started.
 * The item may still be stored; this command did not delete it.
 */
export const storeProgramMissingNotice = (command: string): string =>
  `cannot find ${command}. If the keychain has this device's token, it was not deleted`;

/** `store` stays a failure when the program is missing. The message names the path and not a secret. */
const unavailableWhenBinaryMissing = <A>(
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

const cannotRun = (command: string, error: unknown): KeychainUnavailable =>
  new KeychainUnavailable({ message: `cannot run ${command}: ${errorMessage(error)}` });

/**
 * Runs `command` with `args` and writes `stdin` to the child, then closes it. The token a caller puts in
 * `stdin` is never placed in `args`. `ENOENT` is `StoreBinaryMissing`: the program was not
 * started, which does not prove that no item exists. Any other failure to start, a signal, or no answer within 15s on the Effect
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
        const finished = Promise.all([
          readAllChunks(child.stdout),
          readAllChunks(child.stderr),
          child.exited,
          written
        ]).then(([stdout, stderr, status]) => ({ stdout: decodeChunks(stdout), stderr: decodeChunks(stderr), status }));
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
const lastLine = (stdout: string): string => {
  const lines = stdout.split("\n").filter((line) => line !== "");
  return lines.at(-1) ?? "";
};

/** What a tool that echoes its command line must never do: put the token into a printed failure. */
const redact = (text: string, secret: string | undefined): string =>
  secret === undefined || secret === "" ? text : text.replaceAll(secret, "[redacted]");

/** How a backend turns a non-zero exit into its unavailable error. */
export type SecretCommandFailure = (
  stderr: string,
  stdout: string,
  code: number,
  secret?: string
) => KeychainUnavailable;

/** The non-zero exit both backends report: the binary name, the exit code, the redacted detail. */
export const commandFailureFor = (binary: string): SecretCommandFailure => {
  return (stderr, stdout, code, secret) => {
    const detail = redact((stderr !== "" ? stderr : stdout).trim(), secret);
    const suffix = detail === "" ? "" : `: ${detail}`;
    return new KeychainUnavailable({ message: `${binary} failed (exit ${code})${suffix}` });
  };
};

/** A read that exited zero: the last non-empty line, or the unavailable error when the tool printed none. */
const readToken = (binary: string, result: CommandResult): Effect.Effect<string, KeychainUnavailable> =>
  Effect.gen(function* () {
    const token = lastLine(result.stdout);
    if (token === "") {
      return yield* new KeychainUnavailable({ message: `${binary} printed no token` });
    }
    return token;
  });

/**
 * The store body both backends share: run the command, and a non-zero exit is the redacted failure. The
 * token is never in `args` — the backend puts it in stdin itself — and `storeProgramMissingNotice` still
 * names the program when it is missing.
 */
export const storeThroughCommand = (options: {
  readonly failed: SecretCommandFailure;
  readonly run: (
    deviceId: string,
    token: string
  ) => Effect.Effect<CommandResult, KeychainUnavailable | StoreBinaryMissing>;
}): ((deviceId: string, token: string) => Effect.Effect<void, KeychainUnavailable>) => {
  const { failed, run } = options;
  return (deviceId, token) =>
    unavailableWhenBinaryMissing(
      Effect.gen(function* () {
        const result = yield* run(deviceId, token);
        if (result.code !== 0) {
          return yield* failed(result.stderr, result.stdout, result.code, token);
        }
      })
    );
};

/**
 * The read body both backends share: run the command, read the backend's "no such item" as undefined, turn
 * any other non-zero exit into the redacted failure, then read the token.
 */
export const readThroughCommand = (options: {
  readonly binary: string;
  readonly absent: (result: CommandResult) => boolean;
  readonly failed: SecretCommandFailure;
  readonly run: (deviceId: string) => Effect.Effect<CommandResult, KeychainUnavailable | StoreBinaryMissing>;
}): ((deviceId: string) => Effect.Effect<string | undefined, KeychainUnavailable | StoreBinaryMissing>) => {
  const { absent, binary, failed, run } = options;
  return (deviceId) =>
    Effect.gen(function* () {
      const result = yield* run(deviceId);
      if (absent(result)) {
        return undefined;
      }
      if (result.code !== 0) {
        return yield* failed(result.stderr, result.stdout, result.code);
      }
      return yield* readToken(binary, result);
    });
};
