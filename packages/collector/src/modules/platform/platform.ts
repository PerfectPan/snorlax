import type { Platform } from "@rivus/agent-kit/platform";
import { PlatformService } from "@rivus/agent-kit/platform/effect";
import { Context, Effect, Layer } from "effect";

/**
 * The agent-kit platform the collector runs on. The Node entrypoint derives it from the kit's `PlatformService`
 * (`NodePlatformLive`); tests provide the Node platform over a temporary home, or the kit's memory platform with
 * the process members it lacks filled in. `sqlite` is optional on the kit's interface: the Node platform has it,
 * and the ledger refuses to run without it.
 */
export class SnorlaxPlatform extends Context.Service<SnorlaxPlatform, Platform>()("snorlax/platform/SnorlaxPlatform") {
  /** The kit platform's Node implementation, as the collector sees it. */
  static readonly fromKitPlatform: Layer.Layer<SnorlaxPlatform, never, PlatformService> = Layer.effect(
    SnorlaxPlatform,
    Effect.gen(function* () {
      const platform = yield* PlatformService;
      return SnorlaxPlatform.of(platform);
    })
  );
}
