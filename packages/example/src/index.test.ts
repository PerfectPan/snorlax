import { describe, expect, it } from "vite-plus/test";

import { greet } from "./index.js";

describe("greet", () => {
  it("greets a trimmed name", () => {
    expect(greet("  Ada ")).toBe("Hello, Ada!");
  });

  it("uses custom punctuation", () => {
    expect(greet("Ada", { punctuation: "." })).toBe("Hello, Ada.");
  });

  it("rejects an empty name", () => {
    expect(() => greet("   ")).toThrow(TypeError);
  });
});
