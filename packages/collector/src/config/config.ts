import { join } from "node:path";

import type { Platform } from "@rivus/agent-kit/platform";
import { SnorlaxPlatform } from "../platform.ts";
import { Context, Effect, Layer } from "effect";
import * as z from "zod/mini";

import { DataDir } from "../data-dir/data-dir.ts";
import { CommandError } from "../errors.ts";
import { errorMessage } from "../util/error-message.ts";
import { readTextFile } from "../util/read-text-file.ts";

/**
 * `<data>/config.json` holds the user's choices that are not secrets: the device name and the backend URL
 * (plan 3.2.1, 3.4.2). It is parsed with a schema at the boundary; a file that is present but invalid is a
 * `data-dir` failure rather than a silent fallback, so corruption surfaces in `status` and `doctor`.
 */
export const configSchema = z.object({
  deviceName: z.optional(z.string().check(z.minLength(1))),
  backendUrl: z.optional(z.string().check(z.minLength(1)))
});
export type ConfigValue = z.output<typeof configSchema>;

export const configFilePath = (dataDir: string): string => join(dataDir, "config.json");

export async function readConfig(platform: Pick<Platform, "fs">, dataDir: string): Promise<ConfigValue> {
  const path = configFilePath(dataDir);
  const text = await readTextFile(platform, path);
  if (text === undefined) {
    return {};
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new CommandError({ code: "data-dir", message: `${path} is not valid JSON: ${errorMessage(error)}` });
  }
  const parsed = z.safeParse(configSchema, json);
  if (!parsed.success) {
    throw new CommandError({
      code: "data-dir",
      message: `${path} does not match the expected shape: ${z.prettifyError(parsed.error)}`
    });
  }
  return parsed.data;
}

/**
 * Reads `<data>/config.json` on every call; nothing is read or opened when the layer is built. A
 * missing file is the default config, not a failure.
 */
export class ConfigStore extends Context.Service<
  ConfigStore,
  {
    readonly read: Effect.Effect<ConfigValue, CommandError>;
  }
>()("snorlax/config/ConfigStore") {
  static readonly live: Layer.Layer<ConfigStore, never, SnorlaxPlatform | DataDir> = Layer.effect(
    ConfigStore,
    Effect.gen(function* () {
      const platform = yield* SnorlaxPlatform;
      const dataDir = yield* DataDir;
      return ConfigStore.of({
        read: Effect.tryPromise({
          try: () => readConfig(platform, dataDir.path),
          catch: (error) =>
            error instanceof CommandError ? error : new CommandError({ code: "data-dir", message: errorMessage(error) })
        })
      });
    })
  );
}
