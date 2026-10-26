import type { D1Database } from "./db.ts";
import { createHandler, type Handler } from "./handler.ts";

/**
 * The Workers entry (plan 3.12): the only Workers-specific piece, wiring the bindings and the runtime
 * clock into the handler. `src/handler.ts` and everything it depends on stays runtime-agnostic, so the
 * same handler also runs under plain Node when self-hosting.
 */

interface Env {
  readonly DB: D1Database;
  readonly ADMIN_TOKEN: string;
}

let handler: Handler | undefined;

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    // Bindings are fixed for an isolate's lifetime, so the handler and its route patterns are built once.
    handler ??= createHandler({ db: env.DB, adminToken: env.ADMIN_TOKEN, now: Date.now });
    return handler(request);
  }
};
