# Feed UI verification — issue #302

Device checks performed on 2026-10-06 in the main checkout. Remaining verification limits are listed below. The existing API on :3000, Metro on :8081 and USB phone were reused; no server was started or manually restarted.

Device: OPPO CPH2213, Android 13, 1080×2400 at 480dpi (360dp wide). Standard and 1.35× font sizes were inspected after app reload. The original 1.0 font setting was restored. USB forwards for :3000/:8081 were restored.

## Observed device results

- Overview follows the accepted module order: Stories, Latest updates, Calendar, unavailable wallet activity, Jupiter stats.
- Swiping to Bitcoin and opening its Story showed the matching detail and timeline. Android Back retained the selected Story and reading position.
- All updates loaded reports beyond the first 20. Opening the Morpho report showed its full body; Back retained the older list position.
- Calendar Week covered 5–11 October in UTC and returned 49 real events: 37 earnings and 12 economic. Day selection, previous/next controls and agenda scrolling worked.
- Retail Sales MoM (Aug) detail matched the API: 09:00 UTC, previous -0.6%, estimate 0.2%, actual 0.1%. Closing details and All events preserved the selected period.
- Temporarily removing only the phone's :3000 forward produced a calendar load error. Restoring it and tapping Retry loaded the selected week; other modules remained readable.
- Jupiter stats showed SOL price/change, market cap, liquidity and 24h volume. JUP selection and the 5m control worked.
- Overview, Calendar and All events remained readable at 1.35× font after app reload. Smart Money remained unavailable because provider work is on hold.

Device values were checked against the actual Stories, narratives, calendar and Jupiter-backed API responses. The design reference was commit `638bb65343f3681ecfc1641f667ca1f680e50150`.

## Focused automated results

Both focused test suites were rerun successfully on 2026-10-07 before committing. The scoped TypeScript results below are from 2026-10-06.

- `pnpm test:feed` in `apps/hybrid-expo`: **13/13 passed**. Covered UTC boundaries, selected Story identity, report overlap/order, queued updates, cancellation, retry, missing token values and calendar empty/unavailable distinctions.
- `pnpm test:calendar` in `packages/api`: **15/15 passed**, alongside the calendar-only strict TypeScript check. Covered provider parsing, caching, partial/stale data, failures and route validation.
- Feed/Home TypeScript diagnostics passed for 36 scoped root files. Unrelated imported-module diagnostics were excluded; no full-repository check was run.

## Remaining verification limits

Exact 390dp, reduced-motion, TalkBack focus, large-font Story/detail gestures and dynamic font changes without app reload remain unverified. Also unverified on-device: controlled image/avatar failures, real new-report arrival/apply, native partial/stale/provider-unavailable calendar fixtures, and initial Stories-only failure with healthy reports. Relevant automated coverage does not establish those native visual outcomes.

Maestro and shell screen recording were unavailable. Device checks used ADB, screenshots and UI hierarchies. ADB density, font and animation writes were denied; the font check used the phone's Settings UI. No permission grants were attempted.

## Artifact cleanup

On 2026-10-07, generated screenshots, UI dumps, API snapshots and temporary logs were removed at the user's request. This document retains only the written results and limits. Future device captures belong in task-specific system temporary storage and must be cleaned up after testing.
