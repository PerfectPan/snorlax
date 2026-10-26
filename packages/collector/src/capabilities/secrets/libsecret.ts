import type { Platform } from "@rivus/agent-kit/platform";
import type { Context } from "effect";
import { Effect } from "effect";

import { commandPath, KeychainUnavailable, lastLine, runStdinCommand } from "./command.ts";
import type { Secrets } from "./secrets.ts";

/**
 * Linux secret service through `secret-tool` (plan 3.4.2). `store` reads the token from stdin; `lookup` prints
 * it and exits 1 when the item is absent; `clear` removes it. The token is never a process argument.
 * `SNORLAX_SECRET_TOOL` replaces `secret-tool`; tests point it at a stub and never start the real binary.
 */

const LABEL = "--label=snorlax";
const NOT_FOUND = 1;

const attributes = (deviceId: string): readonly string[] => ["service", "snorlax", "account", deviceId];

/** A tool that echoes its command line must not put the token into the failure a command prints. */
const redact = (text: string, secret: string | undefined): string =>
  secret === undefined || secret === "" ? text : text.replaceAll(secret, "[redacted]");

const failed = (stderr: string, stdout: string, code: number, secret?: string): KeychainUnavailable => {
  const detail = redact((stderr !== "" ? stderr : stdout).trim(), secret);
  const suffix = detail === "" ? "" : `: ${detail}`;
  return new KeychainUnavailable({ message: `secret-tool failed (exit ${code})${suffix}` });
};

/** The Linux implementation over `platform`. The env override of `read` is applied by `Secrets`. */
export const libsecretSecrets = (
  platform: Pick<Platform, "env" | "home" | "process">
): Context.Service.Shape<typeof Secrets> => {
  const binary = commandPath(platform.env, "SNORLAX_SECRET_TOOL", "secret-tool");
  const run = (args: readonly string[], stdin: string) => runStdinCommand(platform, binary, args, stdin);
  return {
    read: (deviceId) =>
      Effect.gen(function* () {
        const result = yield* run(["lookup", ...attributes(deviceId)], "");
        if (result.code === NOT_FOUND) {
          return undefined;
        }
        if (result.code !== 0) {
          return yield* failed(result.stderr, result.stdout, result.code);
        }
        const token = lastLine(result.stdout);
        if (token === "") {
          return yield* new KeychainUnavailable({ message: "secret-tool printed no token" });
        }
        return token;
      }),
    store: (deviceId, token) =>
      Effect.gen(function* () {
        const result = yield* run(["store", LABEL, ...attributes(deviceId)], `${token}\n`);
        if (result.code !== 0) {
          return yield* failed(result.stderr, result.stdout, result.code, token);
        }
      }),
    delete: (deviceId) =>
      Effect.gen(function* () {
        const result = yield* run(["clear", ...attributes(deviceId)], "");
        // Clearing an item that is already gone is the state `delete` promises.
        if (result.code !== 0 && result.code !== NOT_FOUND) {
          return yield* failed(result.stderr, result.stdout, result.code);
        }
      })
  };
};
