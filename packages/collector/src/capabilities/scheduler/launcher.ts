import { join } from "node:path";

import { Data } from "effect";

/**
 * The scheduled refresh's launcher (plan 0001 section 7, "Node path changes"): a POSIX shell script in
 * the data directory that resolves Node at run time, so removing the Node `snorlax install` ran with (a
 * version manager, a Homebrew upgrade) no longer stops the schedule in silence. The job files start
 * `/bin/sh <launcher>`; the script prefers the data directory's `node-path` — the file Snorlax.app's
 * discovery keeps current (3.11) — and then the fixed fallbacks, and never searches `PATH`: launchd and
 * systemd run jobs with a minimal one, exactly why the absolute Node path used to go stale.
 */

/** The launcher script's name in the data directory; `uninstall --data` deletes it with the rest. */
export const LAUNCHER_NAME = "refresh.sh";

/** The system shell the job files name: POSIX sh, present on macOS and Linux. */
export const LAUNCHER_SHELL = "/bin/sh";

/** The launcher script `<data>/<name>`; launchd and systemd run it through `/bin/sh`. */
export const launcherPath = (dataDir: string): string => join(dataDir, LAUNCHER_NAME);

/** The launcher script is data, not a program: `/bin/sh` reads it. */
export const LAUNCHER_MODE = 0o644;

/**
 * Where a Node installed outside a version manager ends up, in the order the app's launcher looks
 * (3.11): Homebrew on Apple silicon, Homebrew on Intel and source installs, the system package.
 */
export const NODE_FALLBACKS = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"] as const;

/** The file Snorlax.app's discovery writes the resolved Node into (3.11), and install seeds. */
export const NODE_PATH_FILE = "node-path";

/** The launcher could not be written into the data directory. */
export class LauncherWriteFailed extends Data.TaggedError("LauncherWriteFailed")<{
  readonly message: string;
}> {}

export interface RefreshLauncherSpec {
  /** The absolute data directory install resolved; the script reads `node-path` there. */
  readonly dataDir: string;
  /** The absolute `snorlax.mjs` the refresh runs. */
  readonly cliPath: string;
}

/** One sh word inside single quotes; the `'\''` escape keeps a quote in a path one word. */
const shQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * The launcher script, in one fixed layout: Node from `node-path`, else the first executable fallback,
 * then `exec node <cli> refresh`. A missing or dead `node-path` and every fallback gone is the one
 * failure — exit 127 with the checked locations on stderr, so a run that captures it can say why.
 */
export const renderRefreshLauncher = (spec: RefreshLauncherSpec): string => {
  const fallbacks = NODE_FALLBACKS.join(" ");
  return [
    "#!/bin/sh",
    "# snorlax refresh job: resolves Node at run time, so removing the Node this install ran with",
    "# (a version manager, a Homebrew upgrade) does not stop the schedule. Prefers the data",
    "# directory's node-path, which Snorlax.app keeps current, then the fixed fallbacks. PATH is",
    "# never searched: launchd and systemd run jobs with a minimal one.",
    `data_dir=${shQuote(spec.dataDir)}`,
    `cli=${shQuote(spec.cliPath)}`,
    `node=''`,
    `saved=$(head -n 1 "$data_dir/${NODE_PATH_FILE}" 2>/dev/null)`,
    `if [ -n "$saved" ] && [ -x "$saved" ]; then`,
    `  node=$saved`,
    `else`,
    `  for candidate in ${fallbacks}; do`,
    `    if [ -x "$candidate" ]; then`,
    `      node=$candidate`,
    `      break`,
    `    fi`,
    `  done`,
    `fi`,
    `if [ -z "$node" ]; then`,
    `  echo "snorlax: node not found (checked $data_dir/${NODE_PATH_FILE}, then ${fallbacks})" >&2`,
    `  exit 127`,
    `fi`,
    `exec "$node" "$cli" refresh`,
    ``
  ].join("\n");
};

/**
 * What install writes into `<data>/node-path`: the Node binary running the install. It is a working
 * Node by definition — the CLI is executing on it — so the launcher has a candidate even where no
 * fallback exists (a version manager's directory), and `snorlax install` with another Node re-seeds
 * the file. Snorlax.app's discovery keeps the same file current afterwards (3.11); the launcher only
 * reads it.
 */
export const renderNodePathSeed = (nodePath: string): string => `${nodePath}\n`;
