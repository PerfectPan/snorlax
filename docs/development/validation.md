# Validation and acceptance

Use the [Spec scenarios](../specs/0001-snorlax.md) and automated tests for regressions. The implementation
architecture and operational limits are in [snorlax architecture](../architecture/snorlax.md).

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

The completed Plan 0001 is retired. Its implementation history remains in Git. The behavioral Spec remains
available; retirement does not remove current product contracts or close unrelated follow-up issues.

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

For future owner-run real-workload measurement, `node scripts/measure-scan.ts` prints aggregate counts, elapsed
time, sampled peak RSS and state size. It scans local agent homes; AI agents must not run it against real homes.
Automated tests and benchmarks use generated logs under a temporary HOME and remove that HOME afterwards.

## Regression checks

- `pnpm run check`: formatting, builds, lint, types and tests.
- Protocol regeneration must leave the committed JSON schemas and Swift models unchanged.
- The [macOS guide](../../apps/macos/README.md) documents Xcode and signing checks. Unsigned/ad-hoc tests do not
  validate App Group entitlements or widget gallery availability under another Apple ID.
- Collector fixtures cover scan counting, interrupted transactions, retries, offline recovery, pricing and
  uninstall isolation. Worker tests cover HTTP validation, authorization and sequence semantics.

## Follow-ups outside the retired plan

- [#23](https://github.com/PerfectPan/snorlax/issues/23): custom prices for unknown models.
- [#35](https://github.com/PerfectPan/snorlax/issues/35): first npm publication and Linux installation validation.
- [#37](https://github.com/PerfectPan/snorlax/issues/37): macOS price-change notice.
- [#50](https://github.com/PerfectPan/snorlax/issues/50): second-Apple-ID signing verification.

These issues retain their own completion criteria; accepting the original plan does not mark them implemented.
