import packageJson from "../package.json" with { type: "json" };

/** The collector's own version, inlined from package.json at build time. */
export const version: string = packageJson.version;
