import { isAbsolute, join } from "node:path";

import * as z from "zod/mini";

/**
 * systemd user units that run `snorlax refresh` (plan 3.1). Program paths are absolute because
 * systemd does not search `PATH`. `Environment=` always sets `SNORLAX_HOME` to the absolute data
 * directory install resolved, so the timer does not look that directory up again. Standard output is
 * discarded: the refresh summary already goes to the rotating `logs/snorlax.log` (plan 3.9).
 *
 * systemd expands `%` specifiers in both settings. In `ExecStart` it also expands `$VAR` and `${VAR}`
 * even inside quotes, and `$$` collapses to `$`; quoting does not stop that. `Environment=` does not
 * expand `$`. An exec word therefore doubles `$` as well as `%`, then C-style escapes (`\\`, `\"`,
 * `\n`, `\r`). An environment word doubles `%` and those escapes, and leaves `$` as written. Every
 * value is one double-quoted word, so a path stays one argument.
 */

export const SERVICE_NAME = "snorlax-refresh.service";
export const TIMER_NAME = "snorlax-refresh.timer";
/** Elapse measured from machine boot (systemd.timer(5)). `OnStartupSec` would be from user-manager start. */
export const TIMER_ON_BOOT = "1min";
/** Gap between activations. Matches the LaunchAgent's 300 s `StartInterval`. */
export const TIMER_INTERVAL = "5min";

export interface SystemdUnitSpec {
  readonly nodePath: string;
  readonly cliPath: string;
  /** The absolute data directory install resolved. Written as `SNORLAX_HOME` so the timer uses it. */
  readonly snorlaxHome: string;
}

/** `exec` doubles `$` because `ExecStart` expands it. `assign` leaves `$`, as `Environment=` does. */
export type SystemdWordKind = "exec" | "assign";

/** One double-quoted systemd word. See the file comment for which characters are escaped. */
export const quoteSystemdWord = (value: string, kind: SystemdWordKind): string => {
  let escaped = "";
  for (const char of value) {
    if (char === "\\") {
      escaped += "\\\\";
    } else if (char === '"') {
      escaped += '\\"';
    } else if (char === "%") {
      escaped += "%%";
    } else if (kind === "exec" && char === "$") {
      escaped += "$$";
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

/**
 * Inverse of `quoteSystemdWord` for a word this module wrote. `exec` collapses `$$` to `$`, which is
 * what systemd does to an `ExecStart` argument. `assign` leaves `$` in place. Any other shape reads
 * as undefined.
 */
export const unquoteSystemdWord = (quoted: string, kind: SystemdWordKind): string | undefined => {
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
    if (kind === "exec" && char === "$" && body[index + 1] === "$") {
      value += "$";
      index += 1;
      continue;
    }
    value += char;
  }
  return value;
};

/**
 * `${xdgConfigHome:-<home>/.config}/systemd/user`. `xdgConfigHome` is the user manager's value, not the
 * CLI process's. The XDG base-dir spec says a relative or empty `XDG_CONFIG_HOME` is invalid and is
 * ignored, so the default under `home` is used instead.
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
    `ExecStart=${quoteSystemdWord(spec.nodePath, "exec")} ${quoteSystemdWord(spec.cliPath, "exec")} refresh`,
    "StandardOutput=null",
    "StandardError=null",
    `Environment=${quoteSystemdWord(`SNORLAX_HOME=${spec.snorlaxHome}`, "assign")}`,
    ""
  ];
  return lines.join("\n");
};

/**
 * The timer unit. `WantedBy=timers.target` is what `systemctl enable` installs; without an `[Install]`
 * section enable would succeed and leave the timer uninstalled. `OnBootSec` is measured from machine
 * boot (systemd.timer(5)); `OnStartupSec` would be measured from the user manager's start.
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
 * `$$` collapses to `$`, matching what systemd does with the word.
 */
export const serviceNodePath = (text: string): string | undefined => {
  for (const line of text.split("\n")) {
    const match = EXEC_START.exec(line);
    const quoted = match?.[1];
    if (quoted !== undefined) {
      return unquoteSystemdWord(quoted, "exec");
    }
  }
  return undefined;
};

/**
 * The `Environment=` word of a service this module wrote, or undefined when the line is absent or not ours.
 * `$` is left as written: `Environment=` does not expand it, and a data directory may contain `$`.
 */
export const serviceEnvironment = (text: string): string | undefined => {
  for (const line of text.split("\n")) {
    if (!line.startsWith("Environment=")) {
      continue;
    }
    return unquoteSystemdWord(line.slice("Environment=".length), "assign");
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

const environmentKeySchema = z.string().check(z.regex(/^[A-Za-z_][A-Za-z0-9_]*$/));
const environmentSchema = z.record(z.string(), z.string());

export type SystemctlEnvironment = z.output<typeof environmentSchema>;

/**
 * `systemctl show-environment` output: one `KEY=VALUE` line per variable. The value may itself contain
 * `=`. An empty report is an empty environment. A line that is not `KEY=value`, a key that is not a
 * shell variable name, or a repeated key reads as undefined — the caller must not guess the manager's
 * environment from the CLI process.
 */
export const parseSystemctlEnvironment = (stdout: string): SystemctlEnvironment | undefined => {
  const fields: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    if (line === "") {
      continue;
    }
    const splitAt = line.indexOf("=");
    if (splitAt <= 0) {
      return undefined;
    }
    const key = z.safeParse(environmentKeySchema, line.slice(0, splitAt));
    if (!key.success || fields[key.data] !== undefined) {
      return undefined;
    }
    fields[key.data] = line.slice(splitAt + 1);
  }
  const parsed = z.safeParse(environmentSchema, fields);
  return parsed.success ? parsed.data : undefined;
};
