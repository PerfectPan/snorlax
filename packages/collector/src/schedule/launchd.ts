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
 * cannot be resolved against the process working directory. `/` and the home directory are refused
 * because both contain far more than snorlax's files.
 */
export function resolvedDeletableDataDir(dataDir: string, home: string): string {
  requireAbsolute(dataDir);
  const resolved = resolve(dataDir);
  if (resolved === resolve(home) || resolved === resolve("/")) {
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

/**
 * `platform.fs.remove` rejects a non-empty directory. Children are removed first. `stat` does not
 * follow symlinks, so a symlink is unlinked and its target is left alone.
 */
const removeTree = async (fs: Platform["fs"], path: string): Promise<void> => {
  const stat = await fs.stat(path);
  if (stat === undefined) {
    return;
  }
  if (stat.kind === "dir") {
    for (const entry of await fs.list(path)) {
      await removeTree(fs, join(path, entry.name));
    }
  }
  await fs.remove(path);
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

/** `launchctl print` exits non-zero when the service is not loaded. A spawn failure throws instead. */
const serviceIsLoaded = async (platform: SchedulerPlatform, domain: string): Promise<boolean> => {
  const result = await runLaunchctl(platform, ["print", `${domain}/${LAUNCH_AGENT_LABEL}`]);
  return result.code === 0;
};

const bootout = async (platform: SchedulerPlatform, domain: string, plistPath: string): Promise<void> => {
  const result = await runLaunchctl(platform, ["bootout", domain, plistPath]);
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
  // bootstrap rejects a service that is already loaded, so a repeat install boots out first.
  const domain = guiDomain(currentUid());
  if (await serviceIsLoaded(platform, domain)) {
    await bootout(platform, domain, plistPath);
  }
  await bootstrap(platform, domain, plistPath);
  return plistPath;
}

export async function uninstallLaunchAgent(
  platform: SchedulerPlatform,
  dataDir: string,
  options: { readonly deleteData: boolean }
): Promise<void> {
  requireLaunchd(platform, "uninstall");
  requireAbsolute(dataDir);
  const plistPath = launchAgentPlistPath(platform.home);
  const domain = guiDomain(currentUid());
  if (await serviceIsLoaded(platform, domain)) {
    await bootout(platform, domain, plistPath);
  }
  try {
    await platform.fs.remove(plistPath);
  } catch (error) {
    throw new CliError("internal", `cannot remove ${plistPath}: ${errorMessage(error)}`);
  }
  if (!options.deleteData) {
    return;
  }
  await removeKeychainItem();
  const resolved = resolvedDeletableDataDir(dataDir, platform.home);
  try {
    await removeTree(platform.fs, resolved);
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError("data-dir", `cannot delete the data directory ${resolved}: ${errorMessage(error)}`);
  }
}
