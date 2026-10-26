import { describe, expect, it } from "vite-plus/test";

import { adminTokenText } from "./token.ts";

describe("adminTokenText", () => {
  it("drops one trailing newline and keeps a second", () => {
    expect(adminTokenText("token\n")).toBe("token");
    expect(adminTokenText("token\r\n")).toBe("token");
    expect(adminTokenText("token\n\n")).toBe("token\n");
    expect(adminTokenText("token")).toBe("token");
    expect(adminTokenText("\n")).toBe("");
    expect(adminTokenText(" token \n")).toBe(" token ");
  });
});
