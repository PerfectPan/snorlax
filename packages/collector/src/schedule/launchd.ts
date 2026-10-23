import { isAbsolute, join, resolve } from "node:path";
import process from "node:process";

import type { Platform } from "@rivus/agent-kit/platform";

import { CliError } from "../cli/errors.ts";
import { errorMessage } from "../util/error-message.ts";
import { removeKeychainItem } from "./keychain.ts";
import { LAUNCH_AGENT_LABEL, launchAgentPlistPath, renderLaunchAgentPlist, type LaunchAgentSpec } from "./plist.ts";

/**
 * macOS LaunchAgent install and uninstall.
 *
 * The app's Launch at login (`SMAppService`, 3.11) and this LaunchAgent share one launchd label and are
 * mutually exclusive. Before any change, `launchctl print` must name the loaded service's `path`, and the
 * CLI refuses — touching no file — unless that path is its own `~/Library/LaunchAgents` plist.
 *
 * `SNORLAX_LAUNCHCTL`, when set, is the `launchctl` binary. Tests point it at a stub so they never
 * start the real one and never bootstrap into the caller's gui domain.
 * `SNORLAX_OS` (`darwin`, `linux`, or `win32`), when set, selects the scheduler instead of
 * `platform.os`. The collector test job runs on Linux, and the plist has to be produced by the
 * bundled CLI so `ProgramArguments` names that `snorlax.mjs`. The variable is not copied into the plist.
 * Linux systemd arrives with Batch 8. Plan 3.2.1 has no code for an unsupported platform, and the
 * protocol `FailureCode` union is outside this batch, so the failure uses `internal` with a message
 * that names Batch 8.
 */

const LAUNCHCTL_TIMEOUT_MS = 15_000;
const PLIST_MODE = 0o644;
const DEFAULT_LAUNCHCTL = "/bin/launchctl";

/** `run` is the only process operation install uses, matching `CollectorPlatform`. */
type SchedulerPlatform = Pick<Platform, "env" | "fs" | "home" | "os"> & {
  readonly process: Pick<Platform["process"], "run">;
};

type LaunchctlResult = Awaited<ReturnType<SchedulerPlatform["process"]["run"]>>;

const schedulerOs = (platform: Pick<Platform, "env" | "os">): Platform["os"] => {
  const override = platform.env.SNORLAX_OS;
  if (override === undefined || override === "") {
    return platform.os;
  }
  if (override === "darwin" || override === "linux" || override === "win32") {
    return override;
  }
  throw new CliError("internal", "SNORLAX_OS must be darwin, linux, or win32");
};

const requireLaunchd = (platform: Pick<Platform, "env" | "os">, command: "install" | "uninstall"): void => {
  const os = schedulerOs(platform);
  if (os === "darwin") {
    return;
  }
  throw new CliError(
    "internal",
    `snorlax ${command} schedules a LaunchAgent on macOS in this build; ${os} support arrives with Batch 8 (systemd user timer)`
  );
};

const launchctlBinary = (platform: Pick<Platform, "env">): string => {
  const override = platform.env.SNORLAX_LAUNCHCTL;
  if (override === undefined || override === "") {
    return DEFAULT_LAUNCHCTL;
  }
  return override;
};

const requireAbsolute = (dataDir: string): void => {
  if (!isAbsolute(dataDir)) {
    throw new CliError("data-dir", `the data directory must be absolute, got ${dataDir}`);
  }
};

/**
 * `uninstall --data` deletes this directory. Relative paths are refused so a bad `SNORLAX_HOME`
 * cannot be resolved against the process working directory. `/`, the home directory, and its ancestors
 * are refused — compared through `realpath`, so a symlinked spelling is caught too. The directory is
 * only ever emptied entry by entry (`deleteKnownDataEntries`), so nothing outside snorlax's own files
 * is deleted even when a path slips past this guard.
 */
export async function resolvedDeletableDataDir(
  fs: Pick<Platform["fs"], "realpath">,
  dataDir: string,
  home: string
): Promise<string> {
  requireAbsolute(dataDir);
  const resolved = resolve(dataDir);
  if (resolved === resolve(home) || resolved === "/") {
    throw new CliError("data-dir", `refusing to delete the data directory ${dataDir}`);
  }
  const dataReal = await fs.realpath(resolved);
  const homeReal = await fs.realpath(home);
  if (
    dataReal !== undefined &&
    (dataReal === "/" || dataReal === homeReal || (homeReal !== undefined && homeReal.startsWith(`${dataReal}/`)))
  ) {
    throw new CliError("data-dir", `refusing to delete the data directory ${dataDir}`);
  }
  return resolved;
}

/** The running Node binary and the `snorlax.mjs` entry this process was started with. */
export function runningCollectorPaths(): Pick<LaunchAgentSpec, "nodePath" | "cliPath"> {
  const entry = process.argv[1];
  if (entry === undefined || entry === "") {
    throw new CliError("internal", "cannot resolve the running snorlax CLI path");
  }
  const nodePath = process.execPath;
  const cliPath = resolve(entry);
  if (!isAbsolute(nodePath) || !isAbsolute(cliPath)) {
    throw new CliError("internal", "the Node and CLI paths in the LaunchAgent must be absolute");
  }
  return { nodePath, cliPath };
}

const currentUid = (): number => {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new CliError("internal", "launchd install needs a numeric user id");
  }
  return uid;
};

const guiDomain = (uid: number): string => `gui/${uid}`;

type DirEntry = Awaited<ReturnType<Platform["fs"]["list"]>>[number];

/** `fs.list` rejects a missing directory; deletion treats that as nothing left to remove. */
const listOrNothing = async (fs: Platform["fs"], dir: string): Promise<readonly DirEntry[]> => {
  try {
    return await fs.list(dir);
  } catch {
    return [];
  }
};

/**
 * Every entry snorlax writes directly in the data directory (3.3.2, 3.4.2, 3.9, 3.11): the ledger
 * database with its SQLite sidecars and lock files, the config, the snapshot, the app's `node-path`,
 * and the logs directory. Migration backups and crashed atomic-write temps are matched by pattern
 * below. launchd output files no longer exist (StandardOutPath/StandardErrorPath are /dev/null); the
 * `logs` directory still removes the ones older installs wrote.
 */
const KNOWN_DATA_ENTRIES = [
  "ledger.db",
  "ledger.db-wal",
  "ledger.db-shm",
  "ledger.db-journal",
  "ledger.lock",
  "ledger.lock.holder",
  "config.json",
  "snapshot.json",
  "node-path",
  "logs"
] as const;

const LEDGER_BACKUP_PATTERN = /^ledger\.db\.bak-v(\d+)$/;
/** `platform.fs.writeAtomic` leaves `.<16 hex>.tmp` beside the target when a write crashes. */
const ATOMIC_TEMP_PATTERN = /^\.[0-9a-f]{16}\.tmp$/;

/** Files the collector writes inside `logs/` (3.9); the last two are what older installs redirected launchd to. */
const KNOWN_LOG_FILES = [
  "snorlax.log",
  "snorlax.log.1",
  "snorlax.log.2",
  "refresh.stdout.log",
  "refresh.stderr.log"
] as const;

/**
 * Removes `dir` only when it is empty, and returns the entries that kept it alive (mapped through
 * `name` so a nested directory can be reported as `logs/<entry>`). Any other failure — an empty
 * directory that cannot be removed, a listing that comes back unreadable — is a `data-dir` error:
 * a kept directory must never read as deleted.
 */
const removeDirKeepingLeftovers = async (
  fs: Platform["fs"],
  dir: string,
  name: (entry: string) => string = (entry) => entry
): Promise<readonly string[]> => {
  try {
    await fs.remove(dir);
    return [];
  } catch (error) {
    const entries = await listOrNothing(fs, dir);
    if (entries.length === 0) {
      throw new CliError("data-dir", `cannot delete ${dir}: ${errorMessage(error)}`);
    }
    return entries.map((entry) => name(entry.name));
  }
};

/**
 * Deletes only entries snorlax wrote, then removes the directory itself only when nothing else
 * remains; the surviving names are returned for the command output. Nothing here deletes
 * recursively: `logs/` is emptied file by file too, so a data directory that happens to be
 * `~/Library` (same name as `logs`, case-insensitive APFS) cannot lose the user's `Logs` tree.
 * This is the sole deletion path for `uninstall --data`.
 */
const deleteKnownDataEntries = async (fs: Platform["fs"], dir: string): Promise<readonly string[]> => {
  const leftovers: string[] = [];
  for (const name of KNOWN_DATA_ENTRIES) {
    if (name === "logs") {
      const logsDir = join(dir, name);
      for (const logName of KNOWN_LOG_FILES) {
        await fs.remove(join(logsDir, logName));
      }
      leftovers.push(...(await removeDirKeepingLeftovers(fs, logsDir, (entry) => `${name}/${entry}`)));
    } else {
      await fs.remove(join(dir, name));
    }
  }
  for (const entry of await listOrNothing(fs, dir)) {
    if (LEDGER_BACKUP_PATTERN.test(entry.name) || ATOMIC_TEMP_PATTERN.test(entry.name)) {
      await fs.remove(join(dir, entry.name));
    }
  }
  leftovers.push(...(await removeDirKeepingLeftovers(fs, dir)));
  return leftovers.sort();
};

const runLaunchctl = async (platform: SchedulerPlatform, args: readonly string[]) => {
  const command = launchctlBinary(platform);
  let result: LaunchctlResult;
  try {
    result = await platform.process.run(command, args, { timeoutMs: LAUNCHCTL_TIMEOUT_MS });
  } catch (error) {
    throw new CliError("internal", `cannot run launchctl (${command}): ${errorMessage(error)}`);
  }
  if (result.timedOut || result.signal !== null) {
    const reason = result.timedOut ? "timeout" : result.signal;
    throw new CliError("internal", `launchctl ${args[0] ?? "command"} did not finish (${reason})`);
  }
  return result;
};

const launchctlFailure = (result: LaunchctlResult, action: string): CliError => {
  const detail = (result.stderr !== "" ? result.stderr : result.stdout).trim();
  const suffix = detail === "" ? "" : `: ${detail}`;
  return new CliError("internal", `launchctl ${action} failed (exit ${result.code ?? "unknown"})${suffix}`);
};

/**
 * One `launchctl print` outcome for this label: `loaded` carries the plist the loaded service was started
 * from, `unknown` means launchd names no `path` line, so the owner cannot be confirmed.
 */
type LoadedService =
  | { readonly state: "not-loaded" }
  | { readonly state: "loaded"; readonly path: string }
  | { readonly state: "unknown" };

/** The `path = …` line `launchctl print` prints for a service loaded from a plist. */
const SERVICE_PATH_LINE = /^[\t ]*path[\t ]*=[\t ]*(\S.*?)\s*$/;
/** A line ending in `{` opens a nested block; a lone `}` closes one. */
const OPEN_BLOCK = /[{]\s*$/;
const CLOSE_BLOCK = /^[\t ]*}[ ;]*$/;

/**
 * `launchctl print` exits non-zero when the service is not loaded. A spawn failure throws instead. The
 * `path` line only counts in the service's own dictionary (depth 1), never in a nested block that
 * happens to print first.
 */
const loadedService = async (platform: SchedulerPlatform, target: string): Promise<LoadedService> => {
  const result = await runLaunchctl(platform, ["print", target]);
  if (result.code !== 0) {
    return { state: "not-loaded" };
  }
  let depth = 0;
  for (const line of result.stdout.split("\n")) {
    if (depth === 1) {
      const match = SERVICE_PATH_LINE.exec(line);
      if (match?.[1] !== undefined) {
        return { state: "loaded", path: match[1] };
      }
    }
    if (OPEN_BLOCK.test(line)) {
      depth += 1;
    } else if (CLOSE_BLOCK.test(line)) {
      depth -= 1;
    }
  }
  return { state: "unknown" };
};

/**
 * Plan 3.11 keeps the app's `SMAppService` agent and the CLI's LaunchAgent mutually exclusive: launchd
 * holds one label, and two same-label plists would fight over the load at every login. The CLI therefore
 * changes nothing — not its own plist, not the data directory — unless the loaded service provably comes
 * from its own `~/Library/LaunchAgents` plist.
 */
const refuseForeignService = (loaded: LoadedService, plistPath: string, target: string): void => {
  if (loaded.state === "not-loaded" || (loaded.state === "loaded" && loaded.path === plistPath)) {
    return;
  }
  const detail =
    loaded.state === "loaded"
      ? `${LAUNCH_AGENT_LABEL} is already registered by Snorlax.app's Launch at login (${loaded.path}); ` +
        "turn Launch at login off in Snorlax's Settings first"
      : `launchctl print names no plist for the loaded ${LAUNCH_AGENT_LABEL} agent, so its owner cannot be ` +
        `confirmed; check Launch at login in Snorlax's Settings and turn it off, or inspect the service ` +
        `with \`launchctl print ${target}\``;
  throw new CliError("internal", `refusing to change the LaunchAgent: ${detail}`);
};

const bootout = async (platform: SchedulerPlatform, target: string): Promise<void> => {
  const result = await runLaunchctl(platform, ["bootout", target]);
  if (result.code !== 0) {
    throw launchctlFailure(result, "bootout");
  }
};

const bootstrap = async (platform: SchedulerPlatform, domain: string, plistPath: string): Promise<void> => {
  const result = await runLaunchctl(platform, ["bootstrap", domain, plistPath]);
  if (result.code !== 0) {
    throw launchctlFailure(result, "bootstrap");
  }
};

const snorlaxHomeOverride = (platform: Pick<Platform, "env">): string | undefined => {
  const value = platform.env.SNORLAX_HOME;
  if (value === undefined || value === "") {
    return undefined;
  }
  return value;
};

export async function installLaunchAgent(platform: SchedulerPlatform, dataDir: string): Promise<string> {
  requireLaunchd(platform, "install");
  requireAbsolute(dataDir);
  const plistPath = launchAgentPlistPath(platform.home);
  const domain = guiDomain(currentUid());
  const target = `${domain}/${LAUNCH_AGENT_LABEL}`;
  // Ownership comes before any write: a foreign or unattributable service is never replaced.
  const loaded = await loadedService(platform, target);
  refuseForeignService(loaded, plistPath, target);
  const plist = renderLaunchAgentPlist({
    ...runningCollectorPaths(),
    dataDir,
    snorlaxHome: snorlaxHomeOverride(platform)
  });
  try {
    await platform.fs.mkdir(join(platform.home, "Library", "LaunchAgents"));
    await platform.fs.writeAtomic(plistPath, plist, { mode: PLIST_MODE });
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError("internal", `cannot write ${plistPath}: ${errorMessage(error)}`);
  }
  // bootstrap rejects a service that is already loaded, so a repeat install boots out first — by service
  // target, so a hand-deleted plist cannot block the bootout.
  if (loaded.state === "loaded") {
    await bootout(platform, target);
  }
  try {
    await bootstrap(platform, domain, plistPath);
  } catch (error) {
    // The command failed, so it must not leave an installed-looking plist for the next login.
    try {
      await platform.fs.remove(plistPath);
    } catch {
      // Report the bootstrap failure, not the cleanup.
    }
    throw error;
  }
  return plistPath;
}

/** What uninstall did beyond the LaunchAgent itself. */
export interface UninstallResult {
  /** Entries `--data` left in the data directory because snorlax did not write them. */
  readonly dataLeftovers: readonly string[];
}

export async function uninstallLaunchAgent(
  platform: SchedulerPlatform,
  dataDir: string,
  options: { readonly deleteData: boolean }
): Promise<UninstallResult> {
  requireLaunchd(platform, "uninstall");
  requireAbsolute(dataDir);
  const plistPath = launchAgentPlistPath(platform.home);
  const domain = guiDomain(currentUid());
  const target = `${domain}/${LAUNCH_AGENT_LABEL}`;
  const loaded = await loadedService(platform, target);
  refuseForeignService(loaded, plistPath, target);
  if (loaded.state === "loaded") {
    await bootout(platform, target);
  }
  try {
    await platform.fs.remove(plistPath);
  } catch (error) {
    throw new CliError("internal", `cannot remove ${plistPath}: ${errorMessage(error)}`);
  }
  if (!options.deleteData) {
    return { dataLeftovers: [] };
  }
  await removeKeychainItem();
  const resolved = await resolvedDeletableDataDir(platform.fs, dataDir, platform.home);
  try {
    return { dataLeftovers: await deleteKnownDataEntries(platform.fs, resolved) };
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError("data-dir", `cannot delete the data directory ${resolved}: ${errorMessage(error)}`);
  }
}
