import { isAbsolute, join } from "node:path";

import * as z from "zod/mini";

/**
 * systemd user units that run `snorlax refresh` (plan 3.1). Program paths are absolute because
 * systemd does not search `PATH`. `SNORLAX_HOME` is copied into `Environment=` only when install itself was
 * given that override. Standard output is discarded: the refresh summary already goes to the rotating
 * `logs/snorlax.log` (plan 3.9).
 *
 * systemd expands `%` specifiers and, inside quotes, C-style escapes (`\\`, `\"`, `\n`, `\r`) before it
 * splits the line. Every value is written as one double-quoted word with those sequences escaped, so a path
 * stays one argument and a `%` stays a `%`.
 */

export const SERVICE_NAME = "snorlax-refresh.service";
export const TIMER_NAME = "snorlax-refresh.timer";
/** First run after the user manager starts. For a user unit this is not machine boot. */
export const TIMER_ON_BOOT = "1min";
/** Gap between activations. Matches the LaunchAgent's 300 s `StartInterval`. */
export const TIMER_INTERVAL = "5min";

export interface SystemdUnitSpec {
  readonly nodePath: string;
  readonly cliPath: string;
  /** Present when install was started with a non-empty `SNORLAX_HOME`. */
  readonly snorlaxHome?: string;
}

/** One double-quoted systemd word. See the file comment for which characters are escaped. */
export const quoteSystemdWord = (value: string): string => {
  let escaped = "";
  for (const char of value) {
    if (char === "\\") {
      escaped += "\\\\";
    } else if (char === '"') {
      escaped += '\\"';
    } else if (char === "%") {
      escaped += "%%";
    } else if (char === "\n") {
      escaped += "\\n";
    } else if (char === "\r") {
      escaped += "\\r";
    } else {
      escaped += char;
    }
  }
  return `"${escaped}"`;
};

/** Inverse of `quoteSystemdWord` for a word this module wrote. Any other shape reads as undefined. */
export const unquoteSystemdWord = (quoted: string): string | undefined => {
  if (quoted.length < 2 || !quoted.startsWith('"') || !quoted.endsWith('"')) {
    return undefined;
  }
  const body = quoted.slice(1, -1);
  let value = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === undefined) {
      return undefined;
    }
    if (char === "\\") {
      const next = body[index + 1];
      if (next === undefined) {
        return undefined;
      }
      if (next === "n") {
        value += "\n";
      } else if (next === "r") {
        value += "\r";
      } else {
        value += next;
      }
      index += 1;
      continue;
    }
    if (char === "%") {
      if (body[index + 1] !== "%") {
        return undefined;
      }
      value += "%";
      index += 1;
      continue;
    }
    value += char;
  }
  return value;
};

/**
 * `${XDG_CONFIG_HOME:-~/.config}/systemd/user`. The XDG base-dir spec says a relative or empty
 * `XDG_CONFIG_HOME` is invalid and is ignored, so the default under `home` is used instead.
 */
export const systemdUserConfigDir = (home: string, xdgConfigHome: string | undefined): string => {
  if (xdgConfigHome !== undefined && xdgConfigHome !== "" && isAbsolute(xdgConfigHome)) {
    return join(xdgConfigHome, "systemd", "user");
  }
  return join(home, ".config", "systemd", "user");
};

/** The service unit, in one fixed layout. `serviceNodePath` reads that layout back. */
export const renderRefreshService = (spec: SystemdUnitSpec): string => {
  const lines = [
    "[Unit]",
    "Description=Refresh snorlax usage",
    "",
    "[Service]",
    // refresh exits. `simple` would treat that exit as the daemon dying.
    "Type=oneshot",
    `ExecStart=${quoteSystemdWord(spec.nodePath)} ${quoteSystemdWord(spec.cliPath)} refresh`,
    "StandardOutput=null",
    "StandardError=null"
  ];
  if (spec.snorlaxHome !== undefined) {
    lines.push(`Environment=${quoteSystemdWord(`SNORLAX_HOME=${spec.snorlaxHome}`)}`);
  }
  lines.push("");
  return lines.join("\n");
};

/**
 * The timer unit. `WantedBy=timers.target` is what `systemctl enable` installs; without an `[Install]`
 * section enable would succeed and leave the timer uninstalled.
 */
export const renderRefreshTimer = (): string =>
  [
    "[Unit]",
    "Description=Refresh snorlax usage every 5 minutes",
    "",
    "[Timer]",
    `OnBootSec=${TIMER_ON_BOOT}`,
    `OnUnitActiveSec=${TIMER_INTERVAL}`,
    "",
    "[Install]",
    "WantedBy=timers.target",
    ""
  ].join("\n");

const QUOTED_WORD = '"(?:\\\\.|[^"\\\\])*"';
const EXEC_START = new RegExp(`^ExecStart=(${QUOTED_WORD}) (${QUOTED_WORD}) refresh$`);

/**
 * The Node binary — the first `ExecStart` word — of a service in the layout `renderRefreshService` writes,
 * or undefined for any other text. This reads snorlax's own output back instead of parsing unit files.
 */
export const serviceNodePath = (text: string): string | undefined => {
  for (const line of text.split("\n")) {
    const match = EXEC_START.exec(line);
    const quoted = match?.[1];
    if (quoted !== undefined) {
      return unquoteSystemdWord(quoted);
    }
  }
  return undefined;
};

/** The `Environment=` word of a service this module wrote, or undefined when the line is absent or not ours. */
export const serviceEnvironment = (text: string): string | undefined => {
  for (const line of text.split("\n")) {
    if (!line.startsWith("Environment=")) {
      continue;
    }
    return unquoteSystemdWord(line.slice("Environment=".length));
  }
  return undefined;
};

const SHOW_KEYS = ["LoadState", "UnitFileState", "ActiveState", "FragmentPath"] as const;
const showKeySchema = z.enum(SHOW_KEYS);
const showSchema = z.object({
  LoadState: z.string(),
  UnitFileState: z.string(),
  ActiveState: z.string(),
  FragmentPath: z.string()
});

export type SystemctlShow = z.output<typeof showSchema>;

/**
 * `systemctl show --property=…` output: one `Key=value` line per property. A line that is not one of the
 * four properties, a repeated key, or a missing property reads as undefined — the caller then cannot tell
 * what is loaded and must not guess.
 */
export const parseSystemctlShow = (stdout: string): SystemctlShow | undefined => {
  const fields: Partial<Record<(typeof SHOW_KEYS)[number], string>> = {};
  for (const line of stdout.split("\n")) {
    if (line === "") {
      continue;
    }
    const splitAt = line.indexOf("=");
    if (splitAt <= 0) {
      return undefined;
    }
    const key = z.safeParse(showKeySchema, line.slice(0, splitAt));
    if (!key.success || fields[key.data] !== undefined) {
      return undefined;
    }
    fields[key.data] = line.slice(splitAt + 1);
  }
  const parsed = z.safeParse(showSchema, fields);
  return parsed.success ? parsed.data : undefined;
};
