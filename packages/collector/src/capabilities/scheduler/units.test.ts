import { describe, expect, it } from "vite-plus/test";

import {
  parseSystemctlEnvironment,
  parseSystemctlShow,
  quoteSystemdWord,
  renderRefreshService,
  renderRefreshTimer,
  serviceEnvironment,
  serviceNodePath,
  systemdUserConfigDir,
  unquoteSystemdWord
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

  it("doubles $ in ExecStart and leaves it literal in Environment", () => {
    const nodePath = "/opt/$HOME/${HOME}/$$/node";
    const cliPath = "/opt/${USER}/snorlax.mjs";
    const home = "/data/$HOME/${HOME}/$$";
    const text = renderRefreshService({ nodePath, cliPath, snorlaxHome: home });
    expect(text).toBe(
      [
        "[Unit]",
        "Description=Refresh snorlax usage",
        "",
        "[Service]",
        "Type=oneshot",
        'ExecStart="/opt/$$HOME/$${HOME}/$$$$/node" "/opt/$${USER}/snorlax.mjs" refresh',
        "StandardOutput=null",
        "StandardError=null",
        'Environment="SNORLAX_HOME=/data/$HOME/${HOME}/$$"',
        ""
      ].join("\n")
    );
    expect(serviceNodePath(text)).toBe(nodePath);
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

  it("ignores a relative or empty XDG_CONFIG_HOME", () => {
    const fallback = `${HOME}/.config/systemd/user`;
    expect(systemdUserConfigDir(HOME, undefined)).toBe(fallback);
    expect(systemdUserConfigDir(HOME, "")).toBe(fallback);
    expect(systemdUserConfigDir(HOME, "relative")).toBe(fallback);
    expect(systemdUserConfigDir(HOME, "/var/xdg")).toBe("/var/xdg/systemd/user");
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

describe("systemctl show-environment", () => {
  it("reads an empty environment and values that contain =", () => {
    expect(parseSystemctlEnvironment("")).toEqual({});
    expect(parseSystemctlEnvironment("\n")).toEqual({});
    expect(parseSystemctlEnvironment("XDG_CONFIG_HOME=/var/xdg\nEMPTY=\nPATH=/bin=/usr/bin\n")).toEqual({
      XDG_CONFIG_HOME: "/var/xdg",
      EMPTY: "",
      PATH: "/bin=/usr/bin"
    });
  });

  it("rejects a duplicate key, a key that is not a variable name, or a line that is not KEY=value", () => {
    expect(parseSystemctlEnvironment("A=1\nA=2\n")).toBeUndefined();
    expect(parseSystemctlEnvironment("1BAD=x\n")).toBeUndefined();
    expect(parseSystemctlEnvironment("HAS-DASH=x\n")).toBeUndefined();
    expect(parseSystemctlEnvironment("=x\n")).toBeUndefined();
    expect(parseSystemctlEnvironment("not a property\n")).toBeUndefined();
  });
});
