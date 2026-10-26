import * as z from "zod/mini";
import { describe, expect, it } from "vite-plus/test";

import { backendUrlSchema, configSchema } from "./config.ts";

describe("backendUrlSchema", () => {
  const accepts = (value: string): void => {
    expect(z.safeParse(backendUrlSchema, value).success).toBe(true);
  };
  const rejects = (value: string): void => {
    expect(z.safeParse(backendUrlSchema, value).success).toBe(false);
  };

  it("requires https, and allows http only on loopback", () => {
    accepts("https://snorlax.example");
    accepts("https://snorlax.example/sync");
    accepts("http://localhost:8787");
    accepts("http://127.0.0.1:8787/");
    accepts("http://[::1]:8787");
    rejects("snorlax.example.com");
    rejects("http://example.com");
    rejects("ftp://localhost");
    rejects("http://localhost.example.com");
    expect(z.safeParse(configSchema, { deviceName: "Mac", backendUrl: "https://snorlax.example" }).success).toBe(true);
    expect(z.safeParse(configSchema, {}).success).toBe(true);
    expect(z.safeParse(configSchema, { backendUrl: "snorlax.example.com" }).success).toBe(false);
  });
});
