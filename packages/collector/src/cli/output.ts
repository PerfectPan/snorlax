import { redact, redactText } from "@rivus/agent-kit/redact";
import { styleText } from "node:util";
import { Console } from "effect";

import type { Failure } from "@rivus/snorlax-protocol";
import type { Sink } from "./env.ts";

/**
 * Every byte the CLI puts on a stream leaves through here (plan 3.8, 3.13): JSON payloads are
 * redacted as values, human text and messages as strings, so no code path can print a home path or a
 * secret-shaped string. Human text stays plain; the only color is the failure message on stderr, via
 * `styleText` against a TTY without `NO_COLOR`.
 */

/** The output surface the console and the printers share: the sinks plus the color switch. */
export type CliOutputEnv = { readonly stdout: Sink; readonly stderr: Sink; readonly colors: boolean };

type Write = (sink: "stdout" | "stderr", args: ReadonlyArray<unknown>) => void;

const consoleInto = (write: Write): Console.Console => ({
  assert: () => {},
  clear: () => {},
  count: () => {},
  countReset: () => {},
  debug: () => {},
  dir: () => {},
  dirxml: () => {},
  error: (...args) => write("stderr", args),
  group: () => {},
  groupCollapsed: () => {},
  groupEnd: () => {},
  info: (...args) => write("stdout", args),
  log: (...args) => write("stdout", args),
  table: () => {},
  time: () => {},
  timeEnd: () => {},
  timeLog: () => {},
  trace: () => {},
  warn: (...args) => write("stderr", args)
});

/**
 * A Console wired to the CLI's sinks, so effect/cli's help and version rendering lands there too.
 * Everything effect/cli renders on its own — help text, formatted parse errors — passes through
 * `redactText` here: an error line can quote the command line it came from, and that line may name
 * paths under the home (plan 3.8).
 */
export const cliConsole = (env: CliOutputEnv, home: string): Console.Console =>
  consoleInto((sink, args) => env[sink].write(redactText(`${args.map(String).join(" ")}\n`, { home })));

/**
 * A Console that holds effect/cli's rendering back in `buffered` (already redacted) instead of
 * writing it out, so a `--json` run can drop the help text and print exactly one JSON object.
 */
export const bufferedConsole = (
  home: string,
  buffered: { readonly out: string[]; readonly err: string[] }
): Console.Console =>
  consoleInto((sink, args) => {
    const text = redactText(`${args.map(String).join(" ")}\n`, { home });
    if (sink === "stdout") {
      buffered.out.push(text);
    } else {
      buffered.err.push(text);
    }
  });

export const printPayloadJson = (env: CliOutputEnv, home: string, payload: object): void => {
  env.stdout.write(`${JSON.stringify(redact(payload, { home }))}\n`);
};

export const printHuman = (env: CliOutputEnv, home: string, text: string): void => {
  env.stdout.write(redactText(text, { home }));
};

export const failurePayload = (code: string, message: string): Failure => ({
  schemaVersion: 1,
  ok: false,
  error: { code, message }
});

export const printFailureJson = (env: CliOutputEnv, home: string, code: string, message: string): void => {
  printPayloadJson(env, home, failurePayload(code, message));
};

export const printFailureMessage = (env: CliOutputEnv, home: string, message: string): void => {
  const redacted = redactText(message, { home });
  env.stderr.write(env.colors ? `${styleText("red", redacted)}\n` : `${redacted}\n`);
};
