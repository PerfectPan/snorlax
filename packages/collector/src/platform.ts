import type { Platform } from "@rivus/agent-kit/platform";
import { PlatformService } from "@rivus/agent-kit/platform/effect";
import { Context, Effect, Layer } from "effect";

/**
 * The platform surface the collector uses: everything except `process` is the full kit interface, and only
 * `run` is needed from `process`, so `createMemoryPlatform` from `@rivus/agent-kit/testing` satisfies this
 * type in tests. `sqlite` (the ledger) and the process identity members (the ledger lock) exist on the Node
 * platform; tests that never lock or open the ledger leave them out, as the memory platform does.
 */
export type CollectorPlatform = Pick<Platform, "env" | "home" | "os" | "fs" | "clock"> & {
  readonly sqlite?: Platform["sqlite"];
  readonly process: Pick<Platform["process"], "run"> &
    Partial<Pick<Platform["process"], "self" | "identify" | "spawn">>;
};

/**
 * The collector's view of the agent-kit platform. The Node entrypoint derives it from the kit's
 * `PlatformService` (`NodePlatformLive`); tests provide a memory platform directly.
 */
export class SnorlaxPlatform extends Context.Service<SnorlaxPlatform, CollectorPlatform>()(
  "snorlax/platform/SnorlaxPlatform"
) {
  /** The kit platform's Node implementation, as the collector sees it. */
  static readonly fromKitPlatform: Layer.Layer<SnorlaxPlatform, never, PlatformService> = Layer.effect(
    SnorlaxPlatform,
    Effect.gen(function* () {
      const platform = yield* PlatformService;
      return SnorlaxPlatform.of(platform);
    })
  );
}
