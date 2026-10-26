import { bindings, defineConfig } from "cf/config";

/**
 * The Worker configuration (plan 3.12): the D1 database is named `snorlax`, as is the Worker, and the
 * admin token is a secret binding that `cf dev` reads from `.dev.vars`. No account's ids or domain are
 * committed: `--mode production` takes the D1 id from the environment and refuses to run without it, and
 * publishes on `SNORLAX_DOMAIN` when that is set, otherwise on the Worker's workers.dev URL.
 */

/** The local D1 id every non-production mode binds; the local D1 commands accept only an id. */
const LOCAL_D1_ID = "00000000-0000-4000-8000-000000000001";

const optionalEnvironmentValue = (name: string): string | undefined => {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
};

const environmentValue = (name: string): string => {
  const value = optionalEnvironmentValue(name);
  if (value === undefined) {
    throw new Error(`${name} is required in --mode production`);
  }
  return value;
};

/** Where production publishes: the custom domain when one is given, else the workers.dev URL (plan 3.12). */
const publishing = (domain: string | undefined) =>
  domain === undefined ? { workersDev: true } : { domains: [domain], workersDev: false };

export default defineConfig((ctx) => {
  const production = ctx.mode === "production";
  const d1Id = production ? environmentValue("SNORLAX_D1_DATABASE_ID") : LOCAL_D1_ID;
  return {
    worker: {
      name: "snorlax",
      compatibilityDate: "2026-10-20",
      entrypoint: "./src/index.ts",
      ...(production ? publishing(optionalEnvironmentValue("SNORLAX_DOMAIN")) : {}),
      env: {
        DB: bindings.d1({ name: "snorlax", id: d1Id }),
        ADMIN_TOKEN: bindings.secret()
      }
    }
  };
});
