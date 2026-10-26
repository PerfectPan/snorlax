import { describe, expect, it } from "vite-plus/test";

import {
  parseSystemctlShow,
  quoteSystemdWord,
  renderRefreshService,
  renderRefreshTimer,
  serviceEnvironment,
  serviceNodePath,
  systemdUserConfigDir,
  TIMER_INTERVAL,
  TIMER_ON_BOOT,
  unquoteSystemdWord
} from "./units.ts";

const HOME = "/opt/snorlax-test/home";

describe("systemd unit text", () => {
  it("renders the timer at a 5 minute interval", () => {
    const text = renderRefreshTimer();
    expect(text).toBe(
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
      ].join("\n")
    );
    expect(TIMER_ON_BOOT).toBe("1min");
    expect(TIMER_INTERVAL).toBe("5min");
    expect(text).toContain("OnBootSec=1min");
    expect(text).toContain("OnUnitActiveSec=5min");
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
      expect(unquoteSystemdWord(quoteSystemdWord(value))).toBe(value);
    }
    expect(unquoteSystemdWord("/usr/bin/node")).toBeUndefined();
    expect(unquoteSystemdWord('"%')).toBeUndefined();
    expect(unquoteSystemdWord('"%"')).toBeUndefined();
  });

  it("writes an absolute ExecStart and omits Environment when SNORLAX_HOME is unset", () => {
    const nodePath = "/usr/bin/node";
    const text = renderRefreshService({ nodePath, cliPath: "/usr/bin/snorlax.mjs" });
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
        ""
      ].join("\n")
    );
    expect(serviceNodePath(text)).toBe(nodePath);
    expect(nodePath.startsWith("/")).toBe(true);
    expect(serviceEnvironment(text)).toBeUndefined();
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
