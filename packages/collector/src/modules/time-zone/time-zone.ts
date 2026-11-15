import { Context } from "effect";

/**
 * The device's IANA time zone; the snapshot's day windows follow it. Defaults to the
 * runtime's zone, so tests pin it with `Layer.succeed(TimeZone, "Asia/Shanghai")`.
 */
export const TimeZone = Context.Reference<string>("snorlax/time-zone/TimeZone", {
  defaultValue: () => Intl.DateTimeFormat().resolvedOptions().timeZone
});
