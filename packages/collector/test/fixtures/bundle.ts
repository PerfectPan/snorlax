import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** The built CLI. `pnpm run check` builds before it tests; a bare `pnpm test` needs `pnpm run build` first. */
export const bundle = fileURLToPath(new URL("../../dist/snorlax.mjs", import.meta.url));

/** Where one bundle run lives. */
export interface BundleHome {
  /** The run's HOME: a directory under the system temporary directory. */
  readonly home: string;
  /** SNORLAX_HOME; `<home>/data` when omitted. Ignored when `omitSnorlaxHome` is set. */
  readonly dataDir?: string;
  /** Leave `SNORLAX_HOME` unset, so the data directory follows `XDG_DATA_HOME` or the platform default. */
  readonly omitSnorlaxHome?: boolean;
  /** The `launchctl` the run may start: a stub under the temporary directory, or by default a path that does not exist. */
  readonly launchctl?: string;
  /** The `systemctl` the run may start: a stub under the temporary directory, or by default a path that does not exist. */
  readonly systemctl?: string;
  /** `XDG_CONFIG_HOME` of the CLI process. Must be under the temporary directory. The systemd user manager does not use it. */
  readonly xdgConfigHome?: string;
  /** `XDG_DATA_HOME`. Must be under the temporary directory. */
  readonly xdgDataHome?: string;
  /** SNORLAX_OS, for the tests that pick the scheduler. */
  readonly os?: string;
}

const underTemporaryDirectory = (path: string): boolean => {
  const rel = relative(tmpdir(), resolve(path));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

/**
 * The whole environment of a bundle run; nothing of the caller's is inherited. launchd isolates by user, not by HOME,
 * and systemd's user manager is the caller's too, so a temporary HOME alone would still let `doctor`, `install` or
 * `uninstall` reach the real one: launchctl and systemctl are always set here, to a stub or to a path that does not
 * exist, and they and HOME must be temporary.
 */
const bundleEnv = (where: BundleHome): Record<string, string> => {
  const launchctl = where.launchctl ?? join(where.home, "no-launchctl");
  const systemctl = where.systemctl ?? join(where.home, "no-systemctl");
  const paths = [where.home, launchctl, systemctl];
  if (where.xdgConfigHome !== undefined) {
    paths.push(where.xdgConfigHome);
  }
  if (where.xdgDataHome !== undefined) {
    paths.push(where.xdgDataHome);
  }
  for (const path of paths) {
    if (!underTemporaryDirectory(path)) {
      throw new Error(`a bundle run needs its HOME, launchctl and systemctl under ${tmpdir()}, got ${path}`);
    }
  }
  if (!existsSync(bundle)) {
    throw new Error(`${bundle} is missing; run "pnpm --filter @rivus/snorlax run build" first`);
  }
  return {
    HOME: where.home,
    ...(where.omitSnorlaxHome === true ? {} : { SNORLAX_HOME: where.dataDir ?? join(where.home, "data") }),
    SNORLAX_LAUNCHCTL: launchctl,
    SNORLAX_SYSTEMCTL: systemctl,
    PATH: "/usr/bin:/bin",
    ...(where.xdgConfigHome === undefined ? {} : { XDG_CONFIG_HOME: where.xdgConfigHome }),
    ...(where.xdgDataHome === undefined ? {} : { XDG_DATA_HOME: where.xdgDataHome }),
    ...(where.os === undefined ? {} : { SNORLAX_OS: where.os })
  };
};

/** Runs the bundle to completion. */
export const runBundle = (args: readonly string[], where: BundleHome) =>
  spawnSync(process.execPath, [bundle, ...args], { encoding: "utf8", env: bundleEnv(where) });

/** Starts the bundle with stdout and stderr piped, for tests that signal it or close its streams. */
export const spawnBundle = (args: readonly string[], where: BundleHome) =>
  spawn(process.execPath, [bundle, ...args], { env: bundleEnv(where), stdio: ["ignore", "pipe", "pipe"] });
