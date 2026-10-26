import { describe, expect, it } from "vite-plus/test";

import {
  parseSystemctlShow,
  parseSystemctlUnitPath,
  quoteSystemdWord,
  renderRefreshService,
  renderRefreshTimer,
  serviceEnvironment,
  serviceNodePath,
  unquoteSystemdWord,
  userConfigUnitDir
} from "./units.ts";

const HOME = "/opt/snorlax-test/home";

describe("systemd unit text", () => {
  it("renders the timer at a 5 minute interval", () => {
    expect(renderRefreshTimer()).toBe(
      [
        "[Unit]",
        "Description=Refresh snorlax usage every 5 minutes",
        "",
        "[Timer]",
        "OnBootSec=1min",
        "OnUnitActiveSec=5min",
        "",
        "[Install]",
        "WantedBy=timers.target",
        ""
      ].join("\n")
    );
  });

  it("quotes a word so spaces, quotes, percent, backslash and newlines survive a round trip", () => {
    const values = [
      "/usr/bin/node",
      "/opt/snorlax home/bin/node",
      '/opt/say "hi"/node',
      "/opt/100%/node",
      "/opt/a\\b/node",
      "/opt/a\nb/node",
      "/opt/a\rb/node",
      'C:\\100% "odd"\\node'
    ];
    for (const value of values) {
      expect(unquoteSystemdWord(quoteSystemdWord(value, "program"), "program")).toBe(value);
      expect(unquoteSystemdWord(quoteSystemdWord(value, "assign"), "assign")).toBe(value);
      expect(unquoteSystemdWord(quoteSystemdWord(value, "exec"), "exec")).toBe(value);
    }
    expect(unquoteSystemdWord("/usr/bin/node", "exec")).toBeUndefined();
    expect(unquoteSystemdWord('"%', "exec")).toBeUndefined();
    expect(unquoteSystemdWord('"%"', "exec")).toBeUndefined();
  });

  it("writes an absolute ExecStart and always sets SNORLAX_HOME", () => {
    const text = renderRefreshService({
      nodePath: "/usr/bin/node",
      cliPath: "/usr/bin/snorlax.mjs",
      snorlaxHome: "/var/lib/snorlax"
    });
    expect(text).toBe(
      [
        "[Unit]",
        "Description=Refresh snorlax usage",
        "",
        "[Service]",
        "Type=oneshot",
        'ExecStart="/usr/bin/node" "/usr/bin/snorlax.mjs" refresh',
        "StandardOutput=null",
        "StandardError=null",
        'Environment="SNORLAX_HOME=/var/lib/snorlax"',
        ""
      ].join("\n")
    );
    expect(serviceNodePath(text)).toBe("/usr/bin/node");
  });

  it("leaves $ literal in the ExecStart program and doubles it only in later arguments", () => {
    const nodePath = "/opt/$HOME/${HOME}/$$/node";
    const cliPath = "/opt/${USER}/snorlax.mjs";
    const home = "/data/$HOME/${HOME}/$$";
    const text = renderRefreshService({ nodePath, cliPath, snorlaxHome: home });
    // systemd executes the program as written and collapses $$ only in the arguments after it.
    expect(text).toBe(
      [
        "[Unit]",
        "Description=Refresh snorlax usage",
        "",
        "[Service]",
        "Type=oneshot",
        'ExecStart="/opt/$HOME/${HOME}/$$/node" "/opt/$${USER}/snorlax.mjs" refresh',
        "StandardOutput=null",
        "StandardError=null",
        'Environment="SNORLAX_HOME=/data/$HOME/${HOME}/$$"',
        ""
      ].join("\n")
    );
    expect(serviceNodePath(text)).toBe(nodePath);
    expect(serviceNodePath('ExecStart="/opt/a$$b/node" "/opt/$${USER}/snorlax.mjs" refresh\n')).toBe("/opt/a$$b/node");
    expect(serviceEnvironment(text)).toBe(`SNORLAX_HOME=${home}`);
  });

  it("keeps a SNORLAX_HOME with spaces and quotes as one Environment word", () => {
    const home = '/tmp/usage 100% "x"\\y';
    const text = renderRefreshService({
      nodePath: "/usr/bin/node",
      cliPath: "/opt/snorlax/snorlax.mjs",
      snorlaxHome: home
    });
    expect(serviceEnvironment(text)).toBe(`SNORLAX_HOME=${home}`);
    expect(serviceNodePath(text)).toBe("/usr/bin/node");
    expect(text.split("\n").filter((line) => line.startsWith("Environment="))).toHaveLength(1);
  });

  it("reads no Node path from a service in another layout", () => {
    expect(serviceNodePath("ExecStart=/usr/bin/node /usr/bin/snorlax.mjs refresh\n")).toBeUndefined();
    expect(serviceNodePath("")).toBeUndefined();
    expect(serviceEnvironment("Environment=SNORLAX_HOME=/tmp/data\n")).toBeUndefined();
  });

  it("picks the user configuration directory under the home and skips the data directory", () => {
    const config = `${HOME}/.config/systemd/user`;
    const spaced = `${HOME}/my config/systemd/user`;
    expect(
      userConfigUnitDir(HOME, [
        `${HOME}/.local/share/systemd/user`,
        `${HOME}/.config/systemd/user.control`,
        config,
        "/etc/systemd/user"
      ])
    ).toBe(config);
    expect(userConfigUnitDir(HOME, [`${HOME}/.local/share/systemd/user`, "/etc/systemd/user"])).toBeUndefined();
    expect(userConfigUnitDir(HOME, ["/etc/systemd/user", "/usr/lib/systemd/user"])).toBeUndefined();
    expect(userConfigUnitDir(HOME, [`${HOME}work/.config/systemd/user`])).toBeUndefined();
    expect(userConfigUnitDir(HOME, [spaced, `${HOME}/.local/share/systemd/user`])).toBe(spaced);
  });
});

describe("systemctl show", () => {
  const shown = [
    "LoadState=loaded",
    "UnitFileState=enabled",
    "ActiveState=active",
    "FragmentPath=/opt/snorlax-test/home/.config/systemd/user/snorlax-refresh.timer",
    ""
  ].join("\n");

  it("reads the four properties in any order, skipping blank lines", () => {
    expect(parseSystemctlShow(shown)).toEqual({
      LoadState: "loaded",
      UnitFileState: "enabled",
      ActiveState: "active",
      FragmentPath: "/opt/snorlax-test/home/.config/systemd/user/snorlax-refresh.timer"
    });
    expect(
      parseSystemctlShow("\nActiveState=inactive\n\nFragmentPath=\nLoadState=not-found\nUnitFileState=\n")
    ).toEqual({
      LoadState: "not-found",
      UnitFileState: "",
      ActiveState: "inactive",
      FragmentPath: ""
    });
  });

  it("rejects a duplicate key, an unknown key, a missing key, or a line that is not Key=value", () => {
    expect(parseSystemctlShow(`${shown}LoadState=not-found\n`)).toBeUndefined();
    expect(parseSystemctlShow(`${shown}Id=snorlax-refresh.timer\n`)).toBeUndefined();
    expect(parseSystemctlShow("LoadState=loaded\nUnitFileState=enabled\nActiveState=active\n")).toBeUndefined();
    expect(parseSystemctlShow(`${shown}not a property\n`)).toBeUndefined();
    expect(parseSystemctlShow("")).toBeUndefined();
  });
});

describe("systemctl show UnitPath", () => {
  const config = `${HOME}/.config/systemd/user`;

  it("reads a space-separated list, including a double-quoted path", () => {
    const listed = [
      `${HOME}/.config/systemd/user.control`,
      config,
      "/etc/systemd/user",
      `${HOME}/.local/share/systemd/user`,
      "/usr/lib/systemd/user"
    ].join(" ");
    expect(parseSystemctlUnitPath(`UnitPath=${listed}\n`)).toEqual(listed.split(" "));
    expect(parseSystemctlUnitPath("UnitPath=\n")).toEqual([]);
    expect(
      parseSystemctlUnitPath(`UnitPath="/opt/snorlax-test/home/my \\$cfg/systemd/user" /etc/systemd/user\n`)
    ).toEqual(["/opt/snorlax-test/home/my $cfg/systemd/user", "/etc/systemd/user"]);
    expect(
      userConfigUnitDir(HOME, parseSystemctlUnitPath(`UnitPath="${config}" ${HOME}/.local/share/systemd/user\n`) ?? [])
    ).toBe(config);
  });

  it("rejects a report that is not one UnitPath line of absolute or double-quoted paths", () => {
    expect(parseSystemctlUnitPath("")).toBeUndefined();
    expect(parseSystemctlUnitPath("not a property\n")).toBeUndefined();
    expect(parseSystemctlUnitPath(`UnitPath=${config}\nUnitPath=/etc/systemd/user\n`)).toBeUndefined();
    expect(parseSystemctlUnitPath('UnitPath="/opt/unterminated\n')).toBeUndefined();
    expect(parseSystemctlUnitPath(`UnitPath=$'${config}'\n`)).toBeUndefined();
    expect(parseSystemctlUnitPath(`UnitPath=${config} relative/systemd/user\n`)).toBeUndefined();
    expect(parseSystemctlUnitPath('UnitPath=""\n')).toBeUndefined();
  });
});
