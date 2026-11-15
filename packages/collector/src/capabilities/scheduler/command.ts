import { isAbsolute, resolve } from "node:path";
import process from "node:process";

import type { Platform } from "@rivus/agent-kit/platform";
import { Duration, Effect } from "effect";

import { errorMessage } from "../../core/error-message/error-message.ts";

/**
 * What launchd and systemd share: the platform shape, the child runner whose interrupted runs wait for the
 * stopped child, the failure wording, and the CLI path the launcher script bakes in.
 */

/** `run` is the only process operation the schedulers use. */
export type SchedulerPlatform = Pick<Platform, "env" | "fs" | "home"> & {
  readonly process: Pick<Platform["process"], "run">;
};

export type SchedulerCommandResult = Awaited<ReturnType<SchedulerPlatform["process"]["run"]>>;

/** How long a scheduler child may run. */
const SCHEDULER_TIMEOUT_MS = 15_000;

/**
 * How long an interrupted run waits for its stopped child to exit. The kit sends SIGKILL 2 s after SIGTERM, so
 * the child is normally gone well before this; the limit keeps a child that never exits from holding the
 * interrupted run open.
 */
const CHILD_EXIT_LIMIT = Duration.seconds(5);

/** Unit and plist files are data, not programs. */
export const UNIT_FILE_MODE = 0o644;

/** The Node binary or the `snorlax.mjs` entry this process runs from has no absolute path. */
export const runningCliPath = <E extends Error>(
  fail: (message: string) => E,
  where: string
): Effect.Effect<string, E> =>
  Effect.suspend(() => {
    const entry = process.argv[1];
    if (entry === undefined || entry === "") {
      return Effect.fail(fail("cannot resolve the running snorlax CLI path"));
    }
    const cliPath = resolve(entry);
    if (!isAbsolute(cliPath)) {
      return Effect.fail(fail(`the CLI path in the ${where} must be absolute`));
    }
    return Effect.succeed(cliPath);
  });

/**
 * One manager command: a Bearer-free child under the timeout, and a did-not-finish failure that names the
 * subcommand the caller asked for. An interrupted run stops the child and waits, up to `CHILD_EXIT_LIMIT` on
 * the Effect clock, until it has exited — the kit settles `run` only after the child has closed — so whatever
 * the interrupted run reads from the manager next is no longer changing under it.
 */
export const runSchedulerCommand = <E extends Error>(
  platform: SchedulerPlatform,
  options: {
    /** The manager's binary, resolved. */
    readonly program: string;
    /** The manager's name as the failure messages say it. */
    readonly name: string;
    readonly args: readonly string[];
    /** The argument a did-not-finish message names: launchctl's subcommand, systemctl's second word. */
    readonly actionArg?: number;
    readonly fail: (message: string) => E;
  }
): Effect.Effect<SchedulerCommandResult, E> =>
  Effect.callback<SchedulerCommandResult, E>((resume) => {
    const controller = new AbortController();
    const running = Promise.resolve().then(() =>
      platform.process.run(options.program, options.args, {
        timeoutMs: SCHEDULER_TIMEOUT_MS,
        signal: controller.signal
      })
    );
    void running.then(
      (result) => resume(Effect.succeed(result)),
      (error: unknown) =>
        resume(
          Effect.fail(options.fail(`cannot run ${options.name} (${options.program}): ${errorMessage(error)}`))
        )
    );
    return Effect.sync(() => controller.abort()).pipe(
      Effect.andThen(Effect.ignore(Effect.tryPromise(() => running))),
      Effect.timeoutOption(CHILD_EXIT_LIMIT),
      Effect.asVoid
    );
  }).pipe(
    Effect.flatMap((result) => {
      if (result.timedOut || result.signal !== null) {
        const reason = result.timedOut ? "timeout" : result.signal;
        const action = options.args[options.actionArg ?? 0] ?? "command";
        return Effect.fail(options.fail(`${options.name} ${action} did not finish (${reason})`));
      }
      return Effect.succeed(result);
    })
  );

/** A non-zero exit as the manager's error: the detail is the stderr, or the stdout when stderr is empty. */
export const schedulerCommandFailure = <E extends Error>(
  result: SchedulerCommandResult,
  options: { readonly name: string; readonly action: string; readonly fail: (message: string) => E }
): E => {
  const detail = (result.stderr !== "" ? result.stderr : result.stdout).trim();
  const suffix = detail === "" ? "" : `: ${detail}`;
  return options.fail(`${options.name} ${options.action} failed (exit ${result.code ?? "unknown"})${suffix}`);
};
