import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { bundle } from "./fixtures/bundle.ts";

/**
 * The build writes the license notices of every package the bundle inlines next to it (Vite's `build.license`), and
 * the package ships them with `dist/`. The list comes from the bundle's modules, so these tests read the built file.
 */
const notices = join(dirname(bundle), "THIRD_PARTY_LICENSES.md");

/** Each `## <name> - <version> (<license>)` section by package name, with the text below its heading. */
const sectionsOf = (markdown: string): Map<string, { readonly heading: string; readonly text: string }> =>
  new Map(
    markdown
      .split(/^## /m)
      .slice(1)
      .map((section) => {
        const [heading = "", ...text] = section.split("\n");
        return [heading.split(" - ")[0] ?? "", { heading, text: text.join("\n").trim() }];
      })
  );

describe("third-party licenses", () => {
  it("names inlined packages with their license and its full text", async () => {
    const sections = sectionsOf(await readFile(notices, "utf8"));
    for (const name of ["effect", "zod", "@rivus/agent-kit"]) {
      expect(sections.get(name)?.heading).toMatch(/^\S+ - \d+\.\d+\.\d+ \(MIT\)$/);
      expect(sections.get(name)?.text).toContain("Permission is hereby granted, free of charge");
    }
  });

  it("carries license text for every package", async () => {
    // Vite writes only the heading for a package without a LICENSE file; such a package needs a look before it ships.
    const withoutText = [...sectionsOf(await readFile(notices, "utf8"))]
      .filter(([, section]) => section.text === "")
      .map(([name]) => name);
    expect(withoutText).toEqual([]);
  });
});
