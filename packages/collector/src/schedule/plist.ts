import { join } from "node:path";

/**
 * LaunchAgent that runs `snorlax refresh` every 300 seconds (plan 3.11 fallback).
 * Program paths are absolute because launchd does not search `PATH`. `SNORLAX_HOME` is copied
 * into `EnvironmentVariables` only when install itself was given that override; otherwise the
 * agent uses the default data directory, and launchd's gui domain already sets `HOME`.
 */
export const LAUNCH_AGENT_LABEL = "io.github.perfectpan.snorlax.refresh";
export const LAUNCH_AGENT_PLIST_NAME = `${LAUNCH_AGENT_LABEL}.plist`;
export const REFRESH_INTERVAL_SECONDS = 300;

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

export const refreshStdoutLog = (dataDir: string): string => join(dataDir, "logs", "refresh.stdout.log");

export const refreshStderrLog = (dataDir: string): string => join(dataDir, "logs", "refresh.stderr.log");

/** XML property list. Callers parse it back; do not match the text loosely. */
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
    stringEntry("StandardOutPath", refreshStdoutLog(spec.dataDir), 1),
    stringEntry("StandardErrorPath", refreshStderrLog(spec.dataDir), 1)
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
