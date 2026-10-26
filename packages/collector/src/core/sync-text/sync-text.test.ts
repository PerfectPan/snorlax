import { describe, expect, it } from "vite-plus/test";

import { syncLine } from "./sync-text.ts";

describe("syncLine", () => {
  it("names unpaired and revoked, and appends a reason when the report has one", () => {
    expect(syncLine({ ok: false, state: "unpaired", pushed: 0, pulled: 0 })).toBe("sync: not paired");
    expect(syncLine({ ok: false, state: "revoked", pushed: 0, pulled: 0 })).toBe("sync: revoked");
    expect(syncLine({ ok: false, state: "revoked", pushed: 0, pulled: 0, message: "HTTP 401: nope" })).toBe(
      "sync: revoked (HTTP 401: nope)"
    );
    expect(syncLine({ ok: false, state: "failed", pushed: 1, pulled: 2, message: "HTTP 403: nope" })).toBe(
      "sync: failed, pushed 1, pulled 2 (HTTP 403: nope)"
    );
    expect(syncLine({ ok: true, state: "ok", pushed: 1, pulled: 2 })).toBe("sync: ok, pushed 1, pulled 2");
  });
});
