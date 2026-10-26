import type { Platform } from "@rivus/agent-kit/platform";
import { Context, Effect, Layer } from "effect";

import { SnorlaxPlatform } from "../../modules/platform/platform.ts";
import { KeychainUnavailable, StoreBinaryMissing, storeProgramMissingNotice } from "./command.ts";
import { keychainSecrets } from "./keychain.ts";
import { libsecretSecrets } from "./libsecret.ts";

export { KeychainUnavailable, StoreBinaryMissing, storeProgramMissingNotice };

type SecretsShape = {
  /** The device token, or undefined when none is stored. `SNORLAX_DEVICE_TOKEN` overrides the store. */
  readonly read: (deviceId: string) => Effect.Effect<string | undefined, KeychainUnavailable | StoreBinaryMissing>;
  readonly store: (deviceId: string, token: string) => Effect.Effect<void, KeychainUnavailable>;
  readonly delete: (deviceId: string) => Effect.Effect<void, KeychainUnavailable | StoreBinaryMissing>;
};

/**
 * `SNORLAX_DEVICE_TOKEN`, when set and non-empty, is the token `read` returns for every device id. Store and
 * delete still talk to the implementation, so a test can inject a token without a keychain (plan 3.4.2).
 */
const withOverride = (env: Platform["env"], service: SecretsShape): SecretsShape => ({
  read: (deviceId) => {
    const override = env.SNORLAX_DEVICE_TOKEN;
    if (override !== undefined && override !== "") {
      return Effect.succeed(override);
    }
    return service.read(deviceId);
  },
  store: (deviceId, token) => service.store(deviceId, token),
  delete: (deviceId) => service.delete(deviceId)
});

/**
 * The device token store (plan 3.4.2, 3.13). One Layer per implementation, picked by `cli/bin.ts` from
 * `platform.os`: the macOS keychain, libsecret on Linux, and a failure on any other system. Tests use
 * `memory` or point `SNORLAX_SECURITY` / `SNORLAX_SECRET_TOOL` at a stub.
 */
export class Secrets extends Context.Service<Secrets, SecretsShape>()("snorlax/secrets/Secrets") {
  /** The macOS login keychain (`keychain.ts`). */
  static readonly keychain: Layer.Layer<Secrets, never, SnorlaxPlatform> = Layer.effect(
    Secrets,
    Effect.gen(function* () {
      const platform = yield* SnorlaxPlatform;
      return Secrets.of(withOverride(platform.env, keychainSecrets(platform)));
    })
  );

  /** libsecret (`libsecret.ts`). */
  static readonly libsecret: Layer.Layer<Secrets, never, SnorlaxPlatform> = Layer.effect(
    Secrets,
    Effect.gen(function* () {
      const platform = yield* SnorlaxPlatform;
      return Secrets.of(withOverride(platform.env, libsecretSecrets(platform)));
    })
  );

  /**
   * An in-memory store. `items` is kept as given, so a test can insert a token after the layer is built.
   * The env override applies here too.
   */
  static readonly memory = (env: Platform["env"], items: Map<string, string> = new Map()): Layer.Layer<Secrets> =>
    Layer.succeed(
      Secrets,
      Secrets.of(
        withOverride(env, {
          read: (deviceId) => Effect.succeed(items.get(deviceId)),
          store: (deviceId, token) =>
            Effect.sync(() => {
              items.set(deviceId, token);
            }),
          delete: (deviceId) =>
            Effect.sync(() => {
              items.delete(deviceId);
            })
        })
      )
    );

  /** A system with neither keychain nor libsecret: every operation fails, and the env override still reads. */
  static readonly unavailable = (os: string): Layer.Layer<Secrets, never, SnorlaxPlatform> =>
    Layer.effect(
      Secrets,
      Effect.gen(function* () {
        const platform = yield* SnorlaxPlatform;
        const fail = () =>
          Effect.fail(
            new KeychainUnavailable({
              message: `${os} has no keychain in this build; macOS uses the login keychain and Linux uses libsecret`
            })
          );
        return Secrets.of(
          withOverride(platform.env, {
            read: () => fail(),
            store: () => fail(),
            delete: () => fail()
          })
        );
      })
    );
}
