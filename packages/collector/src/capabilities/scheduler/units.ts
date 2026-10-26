import { isAbsolute, sep } from "node:path";

import * as z from "zod/mini";

/**
 * systemd user units that run `snorlax refresh` (plan 3.1). Program paths are absolute because
 * systemd does not search `PATH`. `Environment=` always sets `SNORLAX_HOME` to the absolute data
 * directory install resolved, so the timer does not look that directory up again. Standard output is
 * discarded: the refresh summary already goes to the rotating `logs/snorlax.log` (plan 3.9).
 *
 * systemd expands `%` specifiers in both settings. systemd.service(5) does not expand `$` in the
 * program — the first `ExecStart` argument — and does not collapse `$$` there; a doubled `$` would be
 * executed as a literal path and exit 203/EXEC. Later arguments do expand `$VAR` and `${VAR}` inside
 * quotes, and `$$` collapses to `$`. `Environment=` does not expand `$`. The program word therefore
 * doubles `%` and C-style escapes (`\\`, `\"`, `\n`, `\r`) and leaves `$` as written. An argument
 * word doubles `$` as well. An environment word matches the program word on `$`. Every value is one
 * double-quoted word, so a path stays one argument.
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

/**
 * `program` is the first `ExecStart` argument: `$` stays literal. `exec` is a later argument and
 * doubles `$`. `assign` is `Environment=` and leaves `$`.
 */
export type SystemdWordKind = "program" | "exec" | "assign";

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
 * what systemd does to an `ExecStart` argument after the program. `program` and `assign` leave `$` in
 * place: the program is executed as written, and `Environment=` does not expand `$`. Any other shape
 * reads as undefined.
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
 * The user configuration directory in a manager `UnitPath` list. systemd searches that directory before
 * the XDG data directory `…/share/systemd/user`, so the first entry under `home` whose last two segments
 * are `systemd` and `user` is the configuration one; the data entry is skipped. `user.control` and the
 * generator directories do not end in `systemd/user`. An entry outside `home` is not used. No such entry
 * means the caller fails and writes nothing: there is no `~/.config` fallback.
 */
export const userConfigUnitDir = (home: string, paths: readonly string[]): string | undefined => {
  const prefix = home.endsWith(sep) ? home : `${home}${sep}`;
  const configSuffix = `${sep}systemd${sep}user`;
  const dataSuffix = `${sep}share${sep}systemd${sep}user`;
  for (const path of paths) {
    if (!isAbsolute(path) || !path.startsWith(prefix)) {
      continue;
    }
    if (!path.endsWith(configSuffix) || path.endsWith(dataSuffix)) {
      continue;
    }
    return path;
  }
  return undefined;
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
    `ExecStart=${quoteSystemdWord(spec.nodePath, "program")} ${quoteSystemdWord(spec.cliPath, "exec")} refresh`,
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
 * `$` is left as written: systemd executes the program literally and does not collapse `$$`.
 */
export const serviceNodePath = (text: string): string | undefined => {
  for (const line of text.split("\n")) {
    const match = EXEC_START.exec(line);
    const quoted = match?.[1];
    if (quoted !== undefined) {
      return unquoteSystemdWord(quoted, "program");
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

const unitPathSchema = z.array(z.string().check(z.minLength(1)));

/**
 * One double-quoted word as `shell_maybe_quote(path, 0)` writes it (systemd's `UnitPath` printer): `\`
 * escapes the next character, and the C escapes `\n`, `\r`, `\t`, `\a`, `\b`, `\f`, `\v` are the control
 * characters. A dangling `\` reads as undefined.
 */
const unquoteShellDoubleQuoted = (body: string): string | undefined => {
  let value = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === undefined) {
      return undefined;
    }
    if (char !== "\\") {
      value += char;
      continue;
    }
    const next = body[index + 1];
    if (next === undefined) {
      return undefined;
    }
    if (next === "n") {
      value += "\n";
    } else if (next === "r") {
      value += "\r";
    } else if (next === "t") {
      value += "\t";
    } else if (next === "a") {
      value += "\u0007";
    } else if (next === "b") {
      value += "\b";
    } else if (next === "f") {
      value += "\f";
    } else if (next === "v") {
      value += "\v";
    } else {
      value += next;
    }
    index += 1;
  }
  return value;
};

/** The closing quote of a double-quoted word, or undefined when the word does not close. */
const endOfDoubleQuoted = (text: string): number | undefined => {
  for (let index = 1; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") {
      if (index + 1 >= text.length) {
        return undefined;
      }
      index += 1;
      continue;
    }
    if (char === '"') {
      return index;
    }
  }
  return undefined;
};

/**
 * The value of one `UnitPath=` line. Entries are separated by spaces. A path systemd quotes (it contains
 * whitespace, `$`, quotes, or another shell-special character) is one double-quoted word; any other path
 * is an absolute unquoted word. `$''` is not this format. Anything else reads as undefined.
 */
const parseUnitPathValue = (line: string): string[] | undefined => {
  const prefix = "UnitPath=";
  if (!line.startsWith(prefix)) {
    return undefined;
  }
  const paths: string[] = [];
  let rest = line.slice(prefix.length);
  while (rest !== "") {
    while (rest.startsWith(" ")) {
      rest = rest.slice(1);
    }
    if (rest === "") {
      break;
    }
    if (rest.startsWith('"')) {
      const end = endOfDoubleQuoted(rest);
      if (end === undefined) {
        return undefined;
      }
      const value = unquoteShellDoubleQuoted(rest.slice(1, end));
      if (value === undefined) {
        return undefined;
      }
      paths.push(value);
      rest = rest.slice(end + 1);
      if (rest !== "" && !rest.startsWith(" ")) {
        return undefined;
      }
      continue;
    }
    const spaceAt = rest.indexOf(" ");
    const token = spaceAt === -1 ? rest : rest.slice(0, spaceAt);
    if (!token.startsWith("/")) {
      return undefined;
    }
    paths.push(token);
    rest = spaceAt === -1 ? "" : rest.slice(spaceAt);
  }
  return paths;
};

/**
 * `systemctl --user show --property=UnitPath` output: one `UnitPath=` line of space-separated paths, as
 * systemd prints a string-array property. An empty list is a report with no directories. Any other text
 * reads as undefined — the caller must not guess a directory.
 */
export const parseSystemctlUnitPath = (stdout: string): readonly string[] | undefined => {
  const lines = stdout.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  const line = lines[0];
  if (lines.length !== 1 || line === undefined) {
    return undefined;
  }
  const paths = parseUnitPathValue(line);
  if (paths === undefined) {
    return undefined;
  }
  const parsed = z.safeParse(unitPathSchema, paths);
  return parsed.success ? parsed.data : undefined;
};
