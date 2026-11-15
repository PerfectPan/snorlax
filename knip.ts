import { knip } from '@perfectpan/lint-config/knip';
import type { KnipConfig } from 'knip';

// Package entry points resolve from package.json bin/exports; the inline *.test.ts
// files are discovered by vitest. apps/macos is the Swift host and has no
// JavaScript for Knip to analyze. Unused exports/types are staged for a
// dedicated cleanup pass; configuration and tag hints still fail the run.
const config: KnipConfig = {
  ...knip,
  exclude: ['exports', 'types'],
  workspaces: {
    '.': {},
    'packages/collector': {},
    'packages/protocol': {
      // quicktype is a CLI spawned by scripts/generate-swift.ts for Swift codegen.
      ignoreDependencies: ['quicktype']
    },
    'packages/worker': {
      // cloudflare.config.ts is read by the Wrangler-based `cf` deploy CLI, not imported.
      entry: ['cloudflare.config.ts'],
      // wrangler is the bundling engine behind `cf` (see pnpm-workspace.yaml).
      ignoreDependencies: ['wrangler']
    },
    scripts: {
      // Ad-hoc measurement entry point, run directly with tsx.
      entry: ['measure-scan.ts']
    }
  }
};

export default config;
