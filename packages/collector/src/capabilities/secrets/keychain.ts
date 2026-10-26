import type { Platform } from "@rivus/agent-kit/platform";
import type { Context } from "effect";
import { Effect } from "effect";

import { commandPath, KeychainUnavailable, lastLine, runStdinCommand } from "./command.ts";
import type { Secrets } from "./secrets.ts";

/**
 * macOS login keychain through `security -i` (plan 3.4.2). Every command is one line on stdin, so the device
 * token is never a process argument. `security find-generic-password` exits 44 when the item is absent
 * (`errSecItemNotFound`); any other failure means the keychain could not be used. `SNORLAX_SECURITY` replaces
 * `/usr/bin/security`; tests point it at a stub and never start the real binary.
 */

const SERVICE = "snorlax";
const NOT_FOUND = 44;

const commandFor = (deviceId: string, operation: "read" | "store" | "delete", token?: string): string => {
  if (operation === "store") {
    return `add-generic-password -U -s ${SERVICE} -a ${deviceId} -w ${token ?? ""}\n`;
  }
  if (operation === "read") {
    return `find-generic-password -s ${SERVICE} -a ${deviceId} -w\n`;
  }
  return `delete-generic-password -s ${SERVICE} -a ${deviceId}\n`;
};

/** A tool that echoes its command line must not put the token into the failure a command prints. */
const redact = (text: string, secret: string | undefined): string =>
  secret === undefined || secret === "" ? text : text.replaceAll(secret, "[redacted]");

const failed = (stderr: string, stdout: string, code: number, secret?: string): KeychainUnavailable => {
  const detail = redact((stderr !== "" ? stderr : stdout).trim(), secret);
  const suffix = detail === "" ? "" : `: ${detail}`;
  return new KeychainUnavailable({ message: `security failed (exit ${code})${suffix}` });
};

/** The macOS implementation over `platform`. The env override of `read` is applied by `Secrets`. */
export const keychainSecrets = (
  platform: Pick<Platform, "env" | "home" | "process">
): Context.Service.Shape<typeof Secrets> => {
  const binary = commandPath(platform.env, "SNORLAX_SECURITY", "/usr/bin/security");
  const run = (stdin: string) => runStdinCommand(platform, binary, ["-i"], stdin);
  return {
    read: (deviceId) =>
      Effect.gen(function* () {
        const result = yield* run(commandFor(deviceId, "read"));
        if (result.code === NOT_FOUND) {
          return undefined;
        }
        if (result.code !== 0) {
          return yield* failed(result.stderr, result.stdout, result.code);
        }
        const token = lastLine(result.stdout);
        if (token === "") {
          return yield* new KeychainUnavailable({ message: "security printed no token" });
        }
        return token;
      }),
    store: (deviceId, token) =>
      Effect.gen(function* () {
        const result = yield* run(commandFor(deviceId, "store", token));
        if (result.code !== 0) {
          return yield* failed(result.stderr, result.stdout, result.code, token);
        }
      }),
    delete: (deviceId) =>
      Effect.gen(function* () {
        const result = yield* run(commandFor(deviceId, "delete"));
        // Deleting an item that is already gone is the state `delete` promises.
        if (result.code !== 0 && result.code !== NOT_FOUND) {
          return yield* failed(result.stderr, result.stdout, result.code);
        }
      })
  };
};
