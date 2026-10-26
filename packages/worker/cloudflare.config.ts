import { bindings, defineConfig } from "cf/config";

/**
 * The Worker configuration (plan 3.12): the D1 database is named `snorlax`, as is the Worker, and the
 * admin token is a secret binding that `cf dev` reads from `.dev.vars`. No account's ids or domain are
 * committed: `--mode production` takes both from the environment and refuses to run without them.
 */

/** The local D1 id every non-production mode binds; the local D1 commands accept only an id. */
const LOCAL_D1_ID = "00000000-0000-4000-8000-000000000001";

const environmentValue = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required in --mode production`);
  }
  return value;
};

export default defineConfig((ctx) => {
  const d1Id = ctx.mode === "production" ? environmentValue("SNORLAX_D1_DATABASE_ID") : LOCAL_D1_ID;
  const domain = ctx.mode === "production" ? environmentValue("SNORLAX_DOMAIN") : undefined;
  return {
    worker: {
      name: "snorlax",
      compatibilityDate: "2026-10-20",
      entrypoint: "./src/index.ts",
      ...(domain === undefined ? {} : { domains: [domain], workersDev: false }),
      env: {
        DB: bindings.d1({ name: "snorlax", id: d1Id }),
        ADMIN_TOKEN: bindings.secret()
      }
    }
  };
});
