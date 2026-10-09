# Issue 302 — Jupiter heatmap and sampled Birdeye activity

Implemented in the main checkout on 2026-10-08. These provider changes are uncommitted. The user accepted the existing Feed, phone flow and Backpack calendar, and requested automated checks for this stage. No API/Metro server was started or restarted.

## Approved behavior

- Token heatmap: Jupiter `/tokens/v2/tag?query=verified`, explicit `isVerified: true`, up to 20 tokens ranked by known buy + sell USD volume for the selected **5m / 1h / 6h / 24h** window. Tile area is volume; signed price change controls colour; unknown change is neutral. The canonical Solana USDC and USDT mints are excluded; other stable tokens remain eligible. Source, freshness, list and token details use the same response snapshot.
- Smart wallet activity: a limited Birdeye sample from the top three available Jupiter 24h tokens, at most three classified wallets and six upstream requests per refresh. Holder discovery uses `labels=smart_trader,kol`; swap history uses a 30-day lower time bound and a 20-row request limit per wallet. This is a sample of returned swaps, not an exhaustive wallet history or market-wide Smart Money feed.
- Wallet labels remain scoped to the token for which Birdeye returned them. Events include actual wallet/mint/signature, buy/sell, decimal-adjusted amount, available price/value and observed UTC date. UI amounts may come from `ui_amount` or absolute `ui_change_amount`; raw atomic `amount`/`change_amount` are not used. A Solscan link opens the actual transaction. No invented KOL names or relative recent-time claims.
- Shared process caches: one Jupiter snapshot for all four windows and activity seed discovery (five minutes; saved data expires after 30 minutes). Wallet sample refreshes hourly; saved activity expires after six hours. Concurrent requests share work. Provider errors, malformed data, rate limits, partial coverage and stale results remain explicit; failures retain the newest usable activity snapshot without renewing its original freshness. Auth failures stop provider reads; retries respect cooldowns.
- Each module loads independently. Pull-to-refresh includes the new modules; interval switching aborts old requests and cannot relabel another interval's data. Open list/detail sheets keep their original snapshot and return context.
- Backpack earnings/economic calendar remains on its existing API adapter. Market-wide Birdeye `/smart-money/v1/token/list` is excluded because the configured key previously returned 401 for insufficient permissions. No collectors, database migrations, transaction execution or reminders were added.

## Evidence

| Scenario | Evidence |
| --- | --- |
| Verified selection, correct intervals, stable-mint exclusion, exact volume/change and treemap areas | Jupiter backend fixtures, client tests and independent calculation from a real upstream response |
| Wrong/malformed payload, missing values, healthy empty, partial/stale/unavailable, timeout/auth/rate limits | Scoped backend and client decoder regression tests |
| Latest available activity retained through Jupiter/Birdeye outages; original age expires during cooldown | Backend regression fixtures with controlled clocks |
| Interval races, refresh failure and cancellation | React hook and fetch adapter tests |
| Actual wallet/label/token/direction/amount/date consistency and shared caches | Real read-only provider responses through Hono routes in process, decoded by client adapters |
| New native layout, list/detail/back, large text and gestures | **Not performed in this stage**; user requested automated checks while API/USB were unavailable |

Executed scoped checks:

- From `apps/hybrid-expo`: `pnpm test:feed` — **21/21 passed**. The heatmap hook test passed again after its TypeScript assertion fix.
- From `packages/api`: `pnpm test:market-heatmap` — **11/11 passed**; `pnpm test:wallet-activity` — **19/19 passed**.
- API module checks: `pnpm exec tsc --noEmit --module NodeNext --moduleResolution NodeNext --target ES2022 --lib ES2022,DOM --types node --strict --skipLibCheck src/market-heatmap/*.ts`, and the equivalent `src/wallet-activity/*.ts` command — passed.
- TypeScript compiler API checks of 13 changed Feed/Home files and the API bootstrap/config returned zero diagnostics for those files. Imported dependency diagnostics were excluded; no full application/repository typecheck is claimed. The Feed test-file check resolved existing Node types from the API package, without installing dependencies.
- Read-only integration at **2026-10-08T16:44:32Z**: one Jupiter request returned **3,882** verified-universe rows; each window returned 20 eligible tokens. Independently sorted raw buy/sell totals and signed changes exactly matched all four route responses. Windows were marked partial because some universe/metric fields were unavailable.
- The same run made **five Birdeye reads**: three holder responses and one wallet history returned 200; a second wallet history returned 429 and subsequent reads were suppressed. The route returned HTTP 200, `partial`, **seven events**, coverage of three wallets across SOL / jlUSDC / USDG. The displayed sample contained actual September dates, including 2026-09-21 and 2026-09-19. Every event's token-specific labels, wallet, signature, direction, decimal-adjusted amount and observed time matched the captured raw provider records. Client decoding and immediate cache reuse passed. No unavailable market-wide Smart Money endpoint was called.
- A read-only integration audit identified seed-outage retention, freshness-source selection and empty-chain validation defects; all were repaired with focused regressions.

## Remaining and cleanup

The new native screen interactions remain to be checked on the user's running app/phone before final issue closure. Earlier accepted Feed/calendar phone checks cover that earlier implementation. Current provider code and this summary need a user-authorized commit/publication for remote handoff.

Generated scripts and response snapshots lived in a unique system temporary directory outside the repository and were removed after verification. No screenshots/reference images were added. No commit, push, deployment or wallet transaction occurred. The older device-side cleanup dependency recorded in the 2026-10-07 report is unchanged because this stage did not connect to the phone.
