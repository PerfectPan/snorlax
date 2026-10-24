import { join } from "node:path";

/**
 * LaunchAgent that runs `snorlax refresh` every 300 seconds (plan 3.11 fallback).
 * Program paths are absolute because launchd does not search `PATH`. `SNORLAX_HOME` is copied
 * into `EnvironmentVariables` only when install itself was given that override; otherwise the
 * agent uses the default data directory, and launchd's gui domain already sets `HOME`.
 * StandardOutPath/StandardErrorPath are /dev/null: refresh's summary already goes to the rotating
 * `logs/snorlax.log` (plan 3.9), and an unrotated launchd redirect file would only grow.
 */
export const LAUNCH_AGENT_LABEL = "io.github.perfectpan.snorlax.refresh";
export const LAUNCH_AGENT_PLIST_NAME = `${LAUNCH_AGENT_LABEL}.plist`;
export const REFRESH_INTERVAL_SECONDS = 300;

/** launchd redirects both standard streams here; the collector's own log file does the recording. */
export const LAUNCHD_NULL_OUTPUT = "/dev/null";

export interface LaunchAgentSpec {
  readonly nodePath: string;
  readonly cliPath: string;
  readonly dataDir: string;
  /** Present when install was started with a non-empty `SNORLAX_HOME`. */
  readonly snorlaxHome?: string;
}

const xmlText = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const pad = (level: number): string => "  ".repeat(level);

const key = (name: string, level: number): string => `${pad(level)}<key>${xmlText(name)}</key>`;

const stringValue = (value: string, level: number): string => `${pad(level)}<string>${xmlText(value)}</string>`;

const stringEntry = (name: string, value: string, level: number): string =>
  `${key(name, level)}\n${stringValue(value, level)}`;

const stringArray = (name: string, values: readonly string[], level: number): string =>
  [
    key(name, level),
    `${pad(level)}<array>`,
    ...values.map((value) => stringValue(value, level + 1)),
    `${pad(level)}</array>`
  ].join("\n");

/** `~/Library/LaunchAgents/io.github.perfectpan.snorlax.refresh.plist` for this `home`. */
export const launchAgentPlistPath = (home: string): string =>
  join(home, "Library", "LaunchAgents", LAUNCH_AGENT_PLIST_NAME);

/** XML property list in one fixed layout; tests parse it back with a plist parser, not by matching the text. */
export function renderLaunchAgentPlist(spec: LaunchAgentSpec): string {
  const lines = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    stringEntry("Label", LAUNCH_AGENT_LABEL, 1),
    stringArray("ProgramArguments", [spec.nodePath, spec.cliPath, "refresh"], 1),
    key("StartInterval", 1),
    `${pad(1)}<integer>${REFRESH_INTERVAL_SECONDS}</integer>`,
    key("RunAtLoad", 1),
    `${pad(1)}<true/>`,
    stringEntry("StandardOutPath", LAUNCHD_NULL_OUTPUT, 1),
    stringEntry("StandardErrorPath", LAUNCHD_NULL_OUTPUT, 1)
  ];
  if (spec.snorlaxHome !== undefined) {
    lines.push(
      key("EnvironmentVariables", 1),
      `${pad(1)}<dict>`,
      stringEntry("SNORLAX_HOME", spec.snorlaxHome, 2),
      `${pad(1)}</dict>`
    );
  }
  lines.push(`</dict>`, `</plist>`, ``);
  return lines.join("\n");
}

const PROGRAM_NODE_PATH = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/;

/**
 * The Node binary — the first `ProgramArguments` entry — of a plist in the layout `renderLaunchAgentPlist` writes,
 * or undefined for any other layout. This reads snorlax's own output back instead of parsing XML: the `plist`
 * package would read every layout, but its XML parser adds about 260 KB to the single-file bundle for one string.
 */
export const launchAgentNodePath = (xml: string): string | undefined => {
  const value = PROGRAM_NODE_PATH.exec(xml)?.[1];
  // `xmlText` undone; `&amp;` goes last, so `&amp;lt;` reads as `&lt;`, not `<`.
  return value?.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
};
