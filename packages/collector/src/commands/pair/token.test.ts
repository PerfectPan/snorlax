import * as z from "zod/mini";
import { describe, expect, it } from "vite-plus/test";

import { adminTokenSchema, adminTokenText } from "./token.ts";

describe("adminTokenText", () => {
  it("drops one trailing newline and keeps a second", () => {
    expect(adminTokenText("token\n")).toBe("token");
    expect(adminTokenText("token\r\n")).toBe("token");
    expect(adminTokenText("token\n\n")).toBe("token\n");
    expect(adminTokenText("token")).toBe("token");
    expect(adminTokenText("\n")).toBe("");
    expect(adminTokenText(" token \n")).toBe(" token ");
  });

  it("accepts an RFC 6750 bearer token and rejects a newline, a carriage return, and a NUL", () => {
    expect(z.safeParse(adminTokenSchema, "admin-token-not-a-device-token").success).toBe(true);
    expect(z.safeParse(adminTokenSchema, "tok=").success).toBe(true);
    expect(z.safeParse(adminTokenSchema, "").success).toBe(false);
    expect(z.safeParse(adminTokenSchema, "a\nb").success).toBe(false);
    expect(z.safeParse(adminTokenSchema, "a\rb").success).toBe(false);
    expect(z.safeParse(adminTokenSchema, "a\0b").success).toBe(false);
    expect(z.safeParse(adminTokenSchema, "a b").success).toBe(false);
  });
});
