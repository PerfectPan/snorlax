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
  /** SNORLAX_HOME; `<home>/data` when omitted. */
  readonly dataDir?: string;
  /** The `launchctl` the run may start: a stub under the temporary directory, or by default a path that does not exist. */
  readonly launchctl?: string;
  /** SNORLAX_OS, for the tests that pick the scheduler. */
  readonly os?: string;
  /** Written to stdin, then the stream is closed. Empty when omitted, so a read reaches EOF. */
  readonly input?: string;
  /** `SNORLAX_SECURITY`. Tests point it at a stub and never start `/usr/bin/security`. */
  readonly security?: string;
  /** `SNORLAX_SECRET_TOOL`. Tests point it at a stub and never start `secret-tool`. */
  readonly secretTool?: string;
  /** Extra environment entries. HOME, SNORLAX_HOME, SNORLAX_LAUNCHCTL and PATH stay as this helper sets them. */
  readonly extraEnv?: Readonly<Record<string, string>>;
}

const underTemporaryDirectory = (path: string): boolean => {
  const rel = relative(tmpdir(), resolve(path));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

/**
 * The whole environment of a bundle run; nothing of the caller's is inherited. launchd isolates by user, not by HOME,
 * so a temporary HOME alone would still let `doctor`, `install` or `uninstall` reach the caller's gui domain: the
 * launchctl is always set here, to a stub or to a path that does not exist, and both it and HOME must be temporary.
 */
const bundleEnv = (where: BundleHome): Record<string, string> => {
  const launchctl = where.launchctl ?? join(where.home, "no-launchctl");
  for (const path of [where.home, launchctl]) {
    if (!underTemporaryDirectory(path)) {
      throw new Error(`a bundle run needs its HOME and launchctl under ${tmpdir()}, got ${path}`);
    }
  }
  if (!existsSync(bundle)) {
    throw new Error(`${bundle} is missing; run "pnpm --filter @rivus/snorlax run build" first`);
  }
  return {
    ...where.extraEnv,
    HOME: where.home,
    SNORLAX_HOME: where.dataDir ?? join(where.home, "data"),
    SNORLAX_LAUNCHCTL: launchctl,
    PATH: "/usr/bin:/bin",
    ...(where.os === undefined ? {} : { SNORLAX_OS: where.os }),
    ...(where.security === undefined ? {} : { SNORLAX_SECURITY: where.security }),
    ...(where.secretTool === undefined ? {} : { SNORLAX_SECRET_TOOL: where.secretTool })
  };
};

/** Runs the bundle to completion. */
export const runBundle = (args: readonly string[], where: BundleHome) =>
  spawnSync(process.execPath, [bundle, ...args], {
    encoding: "utf8",
    env: bundleEnv(where),
    input: where.input ?? ""
  });

/**
 * Runs the bundle without blocking the event loop. A test that serves HTTP in-process needs this: `spawnSync`
 * would stall the server the child is calling.
 */
export const runBundleAsync = (args: readonly string[], where: BundleHome) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [bundle, ...args], { env: bundleEnv(where) });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (status) =>
      resolve({
        status,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      })
    );
    child.stdin.end(where.input ?? "");
  });

/** Starts the bundle with stdout and stderr piped, for tests that signal it or close its streams. */
export const spawnBundle = (args: readonly string[], where: BundleHome) =>
  spawn(process.execPath, [bundle, ...args], { env: bundleEnv(where), stdio: ["ignore", "pipe", "pipe"] });
