# Validation and acceptance

Use the automated tests and [snorlax architecture](../architecture/snorlax.md) for regressions and current
invariants and operational limits.

## Current acceptance scope

- Milestones 1 and 2 were accepted by the owner. Completed-day token/cost totals were compared with ccusage;
  a small historic Codex discrepancy was accepted, not diagnosed as exact equality.
- On 2026-11-07 the owner confirmed cross-device synchronization was acceptable. This is owner acceptance,
  not a new agent-run claim that every original multi-device/offline/rebuild scenario was repeated.
- On 2026-11-07 the owner accepted the synthetic scan performance result below as sufficient to close the plan.
  No real agent transcript was read or scanned for that measurement. Real multi-agent workload performance is
  not independently verified by it.
- Second-Apple-ID signing verification is deferred to [#50](https://github.com/PerfectPan/snorlax/issues/50).
  This acceptance does not certify that signing case.

The completed initial spec and Plan 0001 are retired; their history remains in Git, while current product
invariants live in [snorlax architecture](../architecture/snorlax.md) and the test suite. Retirement does not close
unrelated follow-up issues.

## Synthetic scanner measurement

Measured on a Mac with Node 24.22.0 against `8d5e0cd` on 2026-11-07 using `measureScan` from
[`scripts/lib/measure-scan.ts`](../../scripts/lib/measure-scan.ts): 100 generated Claude-format JSONL files,
1,000 records each (100,000 total), with one-hour-old mtimes, in an isolated temporary home. The platform received
that home and an explicit environment containing only its HOME. No real session directory was used. The
measurement deleted its temporary home afterwards.

| Phase | Records | Sources | Duration | Peak RSS | State size |
| --- | --- | --- | --- | --- | --- |
| Full | 100,000 | 100 | 999 ms | 159,547,392 bytes | 944,823 bytes |
| Unchanged incremental | 0 | 100 | 39 ms | 164,773,888 bytes | 944,823 bytes |

There were no decode failures. Missing-root results for the other five agents were expected: this fixture only
created Claude-format sources. This is one synthetic run, not a statistical benchmark, a multi-agent benchmark,
an end-to-end refresh measurement or a real-log performance guarantee. Refresh remains at 300 seconds.

`node scripts/measure-scan.ts` scans local agent homes and prints aggregate counts, elapsed time, sampled peak
RSS and state size.
Automated tests and benchmarks use generated logs under a temporary HOME and remove that HOME afterwards.

## Regression checks

- `pnpm run check`: formatting, builds, lint, types, tests and the pending change-record check.
- Protocol regeneration must leave the committed JSON schemas and Swift models unchanged.
- The [macOS guide](../../apps/macos/README.md) documents Xcode and signing checks. Unsigned/ad-hoc tests do not
  validate App Group entitlements or widget gallery availability under another Apple ID.
- Collector fixtures cover scan counting, interrupted transactions, retries, offline recovery, pricing and
  uninstall isolation. Worker tests cover HTTP validation, authorization and sequence semantics.

## Subsequent feature validation

The pricing-change notice (#37), explicit 180-day rebuild and token heatmap are implemented together. Generated
fixtures verify repeated rebuilds and sync retries without double counting, deleted-source zeroing, date/DST
boundaries and unchanged summary windows. Native SwiftUI views were rendered with synthetic data in light and
dark appearances for layout inspection. This is not a production-data run or signing validation.

## Follow-ups outside the retired plan

- [#23](https://github.com/PerfectPan/snorlax/issues/23): custom prices for unknown models.
- [#35](https://github.com/PerfectPan/snorlax/issues/35): first npm publication and Linux installation validation.
- [#50](https://github.com/PerfectPan/snorlax/issues/50): second-Apple-ID signing verification.

These issues retain their own completion criteria; accepting the original plan does not mark them implemented.
