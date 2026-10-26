import type { D1Database } from "./db.ts";
import { createApp } from "./http/app.ts";

/**
 * The Workers entry (plan 3.12.1): the only Workers-specific file, wiring the bindings and the runtime clock
 * into the app. `src/http/app.ts` and everything it depends on stays runtime-agnostic, so the same app also
 * runs under plain Node when self-hosting.
 */

interface Env {
  readonly DB: D1Database;
  readonly ADMIN_TOKEN: string;
}

let app: ReturnType<typeof createApp> | undefined;

export default {
  fetch(request: Request, env: Env): Response | Promise<Response> {
    // Bindings are fixed for an isolate's lifetime, so the app and its routes are built once.
    app ??= createApp({ db: env.DB, adminToken: env.ADMIN_TOKEN, now: Date.now });
    return app.fetch(request);
  }
};
