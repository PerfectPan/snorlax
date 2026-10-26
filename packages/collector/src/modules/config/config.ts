import { join } from "node:path";

import type { Platform } from "@rivus/agent-kit/platform";
import { Data, Effect } from "effect";
import * as z from "zod/mini";

import { errorMessage } from "../../core/error-message/error-message.ts";
import { readTextFile } from "../read-text-file/read-text-file.ts";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** `https`, or `http` only on loopback so `cf dev` can smoke the Worker. `pair` (Batch 7b) reuses this. */
const isBackendUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    if (url.hostname === "") {
      return false;
    }
    if (url.protocol === "https:") {
      return true;
    }
    return url.protocol === "http:" && LOOPBACK.has(url.hostname);
  } catch {
    return false;
  }
};

/**
 * A backend URL `config.json` may store. `z.httpUrl()` accepts any `http:` host and rejects loopback `http:`,
 * which is the opposite of this rule.
 */
export const backendUrlSchema = z.string().check(
  z.refine(isBackendUrl, {
    error: "backendUrl must be an https URL, or http on localhost, 127.0.0.1, or [::1]"
  })
);

/**
 * `<data>/config.json` holds the user's choices that are not secrets: the device name and the backend URL
 * (plan 3.2.1, 3.4.2). It is parsed with a schema at the boundary; a file that is present but invalid fails
 * with `ConfigInvalid` rather than a silent fallback, so corruption surfaces in `status` and `doctor`.
 */
export const configSchema = z.object({
  deviceName: z.optional(z.string().check(z.minLength(1))),
  backendUrl: z.optional(backendUrlSchema)
});
export type ConfigValue = z.output<typeof configSchema>;

/** `config.json` is present but is not JSON or does not match `configSchema`. */
export class ConfigInvalid extends Data.TaggedError("ConfigInvalid")<{ readonly message: string }> {}

/** `config.json` could not be written. The previous file stays in place. */
export class ConfigWriteFailed extends Data.TaggedError("ConfigWriteFailed")<{ readonly message: string }> {}

export const configFilePath = (dataDir: string): string => join(dataDir, "config.json");

/** Reads `config.json`; a missing file is an empty config, and a read that fails for another reason is a defect. */
export const readConfig = (
  platform: Pick<Platform, "fs">,
  dataDir: string
): Effect.Effect<ConfigValue, ConfigInvalid> =>
  Effect.gen(function* () {
    const path = configFilePath(dataDir);
    const text = yield* Effect.promise(() => readTextFile(platform, path));
    if (text === undefined) {
      return {};
    }
    const json = yield* Effect.try({
      try: (): unknown => JSON.parse(text),
      catch: (error) => new ConfigInvalid({ message: `${path} is not valid JSON: ${errorMessage(error)}` })
    });
    const parsed = z.safeParse(configSchema, json);
    if (!parsed.success) {
      return yield* new ConfigInvalid({
        message: `${path} does not match the expected shape: ${z.prettifyError(parsed.error)}`
      });
    }
    return parsed.data;
  });

/**
 * Rewrites `config.json` whole through the platform's atomic write. `JSON.stringify` drops `undefined`, so a
 * config without `backendUrl` keeps only the fields that are set (`unpair` leaves `deviceName`).
 */
export const writeConfig = (
  platform: Pick<Platform, "fs">,
  dataDir: string,
  config: ConfigValue
): Effect.Effect<void, ConfigWriteFailed> => {
  const path = configFilePath(dataDir);
  return Effect.tryPromise({
    try: () => platform.fs.writeAtomic(path, `${JSON.stringify(config)}\n`),
    catch: (error) => new ConfigWriteFailed({ message: `cannot write ${path}: ${errorMessage(error)}` })
  });
};
