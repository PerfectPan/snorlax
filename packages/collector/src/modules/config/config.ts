import { join } from "node:path";

import type { Platform } from "@rivus/agent-kit/platform";
import { Data, Effect } from "effect";
import * as z from "zod/mini";

import { errorMessage } from "../../core/error-message/error-message.ts";
import { readTextFile } from "../read-text-file/read-text-file.ts";

/**
 * `<data>/config.json` holds the user's choices that are not secrets: the device name and the backend URL
 * (plan 3.2.1, 3.4.2). It is parsed with a schema at the boundary; a file that is present but invalid fails
 * with `ConfigInvalid` rather than a silent fallback, so corruption surfaces in `status` and `doctor`.
 */
export const configSchema = z.object({
  deviceName: z.optional(z.string().check(z.minLength(1))),
  backendUrl: z.optional(z.string().check(z.minLength(1)))
});
export type ConfigValue = z.output<typeof configSchema>;

/** `config.json` is present but is not JSON or does not match `configSchema`. */
export class ConfigInvalid extends Data.TaggedError("ConfigInvalid")<{ readonly message: string }> {}

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
