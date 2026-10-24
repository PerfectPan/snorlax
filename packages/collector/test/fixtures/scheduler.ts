import { Effect, Layer } from "effect";

import { ForeignServiceLoaded, Scheduler, type JobInspection } from "../../src/capabilities/scheduler/scheduler.ts";

/** One operation the fake scheduler completed, with the data directory of the job it was given. */
export interface SchedulerCall {
  readonly operation: "install" | "uninstall";
  readonly dataDir: string;
}

export interface FakeSchedulerOptions {
  /** The file an install reports. */
  readonly jobFile: string;
  /** Refuse both operations the way launchd refuses a job that Snorlax.app registered. */
  readonly ownedElsewhere?: boolean;
  /** What `inspect` reports; by default no job file and nothing loaded. */
  readonly inspection?: JobInspection;
}

/**
 * The scheduler capability without launchd: nothing on the machine changes. Each operation runs the caller's
 * `prepare` or `guard` at the point the launchd scheduler does — `prepare` after the ownership check, `guard`
 * before it — and records itself in `calls` only once it has completed. `inspect` reports `options.inspection`.
 */
export const fakeScheduler = (calls: SchedulerCall[], options: FakeSchedulerOptions): Layer.Layer<Scheduler> => {
  const refusal = Effect.suspend(() =>
    options.ownedElsewhere === true
      ? Effect.fail(new ForeignServiceLoaded({ message: "refusing to change the LaunchAgent: owned by the app" }))
      : Effect.void
  );
  return Layer.succeed(
    Scheduler,
    Scheduler.of({
      install: (job, prepare) =>
        Effect.gen(function* () {
          yield* refusal;
          yield* prepare;
          calls.push({ operation: "install", dataDir: job.dataDir });
          return options.jobFile;
        }),
      uninstall: (job, guard) =>
        Effect.gen(function* () {
          const guarded = yield* guard;
          yield* refusal;
          calls.push({ operation: "uninstall", dataDir: job.dataDir });
          return guarded;
        }),
      inspect: Effect.succeed(
        options.inspection ?? { kind: "inspected", cliJob: undefined, loaded: { from: "nothing" } }
      )
    })
  );
};
