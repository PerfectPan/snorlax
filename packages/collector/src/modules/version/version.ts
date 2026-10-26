import process from "node:process";

import { Context } from "effect";

import { version as packageVersion } from "../../../package.json" with { type: "json" };

/** The collector's own version, inlined from package.json at build time. */
export const version: string = packageVersion;

/**
 * Build- and runtime-identifiers the CLI outputs carry: the collector version and the running Node's
 * version string, e.g. `v24.11.0` (checked by `doctor`). A reference with a default, so only tests
 * that pin these values provide a layer.
 */
export const RuntimeInfo = Context.Reference<{
  readonly version: string;
  readonly nodeVersion: string;
}>("snorlax/version/RuntimeInfo", {
  defaultValue: () => ({ version, nodeVersion: process.version })
});
