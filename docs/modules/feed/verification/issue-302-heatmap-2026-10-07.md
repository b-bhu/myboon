# Birdeye token heatmap — issue #302

Historical Birdeye heatmap verification in the main checkout on 2026-10-07. Provider/windows and the Smart Money hold below are superseded by [the 2026-10-08 provider implementation](issue-302-providers-2026-10-08.md). Earlier device observations do not verify the new Jupiter or wallet activity screens.

## Behavior and data

- Solana's top 20 eligible tokens by trading volume for 1h, 4h, 8h or 24h. USDC and USDT are excluded by their Solana mint addresses as requested on 2026-10-08; other stablecoins are retained. The backend requests 22 rows in one provider call, removes those two mints, and returns up to 20 eligible rows for both the map and full list. Tile area represents the selected interval's volume; red/green represents that interval's price change. Missing change is neutral. This is a price/volume heatmap, not liquidation data.
- The client calls `GET /market/token-heatmap?interval=…`. The API alone uses `BIRDEYE_API_KEY` and Birdeye's `/defi/v3/token/list`, sorting by `volume_<interval>_usd` descending.
- Five-minute server caching, same-interval request deduplication, provider request spacing and a shared rate-limit cooldown. Last good server data expires after 30 minutes. No provider key reaches the client.
- Every token remains accessible through the full list, including cells too small for a 44dp tap target. Details retain the chosen token, interval and fetched snapshot.

## Observed checks

- The user's running API on :3000 returned HTTP 200, `ready`, 20 tokens for all four intervals. Snapshots were fetched between 10:23:27 and 10:24:09 UTC. SOL volume differed by interval: approximately $173.29M / $566.27M / $1.09B / $3.41B. Its selected-window price changes were -0.19% / -0.98% / +0.09% / -1.83%.
- A real Birdeye rate-limit response was observed. Requests recovered after cooldown; ready cached data remained usable. Invalid `12h` returned HTTP 400.
- `pnpm test:market-heatmap` in `packages/api`: 12/12 passed. Covers provider parsing, interval fields, timeout, key/error handling, cache/deduplication, stale expiry, request spacing and shared cooldown recovery.
- `pnpm test:feed` in `apps/hybrid-expo`: 18/18 passed. Heatmap coverage includes proportional nonoverlapping layout, missing/extreme values, signs, API validation, interval races, cancellation, refresh failure and recovery, alongside existing Feed regression checks.
- Scoped TypeScript checks passed for the production heatmap client files and backend module. No repository-wide check was run.
- Read-only integration review found no defects. Live data, native observations and mocked tests are separate evidence sources.

## Provider/key follow-up — 2026-10-07

The replacement key supplied by the user returned HTTP 200 with 20 tokens from Birdeye's V3 token list and was saved as `BIRDEYE_API_KEY` in the ignored API `.env`. No key was added to tracked files or the client. The existing API process was not restarted; this check called Birdeye directly with the replacement key.

Birdeye's complete [documentation index](https://data.birdeye.so/docs/llms.txt) listed no earnings or economic calendar endpoint. The 60 public scripts loaded by Backpack's calendar page referenced Backpack's own earnings/economic routes, without Birdeye attribution. Both Backpack routes still returned HTTP 200 for 5–11 October: 38 earnings and 11 economic rows at this later check. Their field names match [Financial Modeling Prep's documented calendar format](https://site.financialmodelingprep.com/developer/docs), but that is an inference about format, not confirmation of Backpack's supplier. Calendar therefore continues using the existing Backpack adapter; no unsupported Birdeye calendar route was introduced. Smart Money remains on hold.

## USDC/USDT exclusion — 2026-10-08

- `pnpm test:market-heatmap`: **14/14 passed**. New coverage checks both mint exclusions in every supported interval, replacement rows preserving twenty eligible tokens, retention of other stablecoins, and excluded-only empty versus malformed results.
- The backend module's isolated strict TypeScript check passed. Read-only integration review found no map/list/count mismatch.
- The user's existing API returned HTTP 200, `ready`, twenty eligible 24h tokens with neither excluded mint present. The subtitle states the exclusions. No server was started or manually restarted, and no new native checks are claimed for this change. It remains uncommitted.

## Native verification status

Partially verified; remaining checks are blocked by USB disconnection. Device: OPPO CPH2213, Android 13 at 1080×2400 / 480dpi (360dp width). The existing app `xyz.myboon.app`, Metro :8081 and USB mappings were reused. Initial attempts interrupted by ChatGPT are excluded from successful evidence.

- Observed the native 24h map, positive/negative tile colours, interval controls and full-list entry. After Refresh, SOL showed -1.83% and $3.4B, matching the API snapshot fetched at 10:24:09 UTC. USDC and USDT's tiny negative changes remained visibly negative rather than rounding to zero.
- Opening SOL displayed its matching address, $117.78 price, $69.4B market cap, $7.0B liquidity and 24h values. The modal tree exposed its own controls rather than the underlying Feed controls. Android Back returned to the 24h map.
- The 1h selector loaded SOL at -0.69% / $174.5M and USDC at +<0.01% / $73.7M, matching the API snapshot fetched at 10:28:43 UTC. A visible scroll jump during an uncached interval load was repaired by reserving the section's content height; the six production client files passed scoped TypeScript checks afterward.
- USB disconnected before the repaired scroll behavior could be retested. Remaining native checks: 4h/8h/24h switching, full-list/small-token access, Back/Close through the list, and API interruption/retry. TalkBack, iOS and release-build performance remain outside the observed evidence.

## Temporary artifacts

Host screenshots, UI dumps, API snapshots and helpers were removed from this task's unique system temporary directory. USB disconnection prevented removal of the device-side directory `/data/local/tmp/myboon-302-heatmap-21q4p9m7`; remove only that owned directory when the phone reconnects. No permanent evidence links point to temporary captures. Existing USB mappings were not changed. No server was started/restarted and no transaction was signed or submitted. New heatmap changes remain uncommitted pending the user's review.
