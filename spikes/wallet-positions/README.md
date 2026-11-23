# Wallet positions spike (#617)

**Spike only. Throwaway code, not production.** Nothing here is wired into `packages/`, the
pnpm workspace, CI, or the database. It answers one question for
[#617](https://github.com/b-bhu/myboon/issues/617): can we read a wallet's positions and PnL
from public APIs well enough to build a wallet watcher? No build starts until the CTO and
Bibhu approve a spec.

All reads are public HTTP. No API keys, no sessions, no writes.

## Contents

```
spikes/wallet-positions/
  hyperliquid/
    snapshot.ts      one wallet's account, positions (native + every HIP-3 dex), spot, PnL, recent fills
    roundtrips.ts    rebuilds open-to-close round trips from fills + funding (our own PnL math)
    sample/          fills.json + funding.json for 0x718c…a868, Nov 6-13 (36 KB), input for roundtrips.ts
  polymarket-perps/
    src/report.ts    Polymarket Perps wallet report, and --diff of two saved snapshots
    src/*.ts         client, types, decimal math, formatting, fill classification, snapshot diff
```

## How to run

Node 22.6+ (tested on Node 24). The Hyperliquid scripts need no install:

```bash
cd spikes/wallet-positions/hyperliquid
node --experimental-strip-types snapshot.ts 0x1f250Df59A777d61Cb8bd043c12970F3AFE4F925 [--hours 48]
node --experimental-strip-types roundtrips.ts            # uses ./sample
node --experimental-strip-types roundtrips.ts DIR out.json  # DIR has fills.json + funding.json
```

Polymarket Perps uses tsx (the repo root has it in devDependencies, or `npx --yes tsx`):

```bash
cd spikes/wallet-positions/polymarket-perps
npx --yes tsx src/report.ts [--out DIR] [--fills-pages N] [--json] 0xWallet   # saves a snapshot to ./snapshots (gitignored)
npx --yes tsx src/report.ts --diff snapshots/old.json snapshots/new.json
npm install && npx tsc -p tsconfig.json   # optional typecheck
```

## Hyperliquid notes

- Endpoint: `POST https://api.hyperliquid.xyz/info`, public. Request types used:
  `clearinghouseState` (perps; pass `dex` for each HIP-3 builder dex), `perpDexs` (lists the
  HIP-3 dexes; first entry is `null` = native), `spotClearinghouseState`, `portfolio`
  (day/week/month/allTime PnL and volume), `userFillsByTime`, `userFunding`.
- `userFillsByTime` returns at most 2000 fills per response, oldest first. Paginate by setting
  `startTime` to the last fill's time + 1. `snapshot.ts` does this.
- Do not use `aggregateByTime: true` for counts or PnL over a window: it aggregates only the
  first 2000 raw fills, so it silently covers a shorter window (see the Nov 17 correction below).
- Liquidation price and margin are public on Hyperliquid (unlike Polymarket Perps).
- Rate limit is 1,200 weight per minute per IP, shared with our market collector.
- `roundtrips.ts` uses `closedPnl` only as a cross-check. A position open before the fills
  window is seeded at the first fill's price and flagged `preWindow` (its entry is unknown).

## Polymarket Perps notes

- Base URL `https://api.perpetuals.polymarket.com`, docs:
  https://docs.polymarket.com/api-reference/perps/overview. Public reads need no key.
- Report: registration, equity, all-time realized PnL, volume, leaderboard rank, each open
  position (side, size, notional, entry, mark, unrealized PnL, return on margin, leverage, open
  time), and recent fills classified as open / add / reduce / close with fees.
- `--diff` compares two saved snapshots and lists positions opened, closed, resized, or flipped.
- Limits: liquidation price, margin, withdrawable and `in_liquidation` are owner-only
  (`GET /v1/account/portfolio`), so they show as n/a. Fills default to the last 30 days, 100
  rows per page. Rate limit is 1,000 weighted tokens per minute per IP, which is roomy for a few
  dozen wallets every few minutes.

## Related work not in this folder

The CTO's position-snapshot spike (Nov 12, Python, `/workspace/hl-tests/` on the shared box)
compared positions across 10 wallets for about 10 minutes, on native perps, all 10 HIP-3 dexes
and spot. It caught real opens, closes, flips and trims. Findings from #617: one wallet had 80
sub-accounts holding 231 positions; checking every 60-120 s catches moves well; the rate limit
allows about 20-25 wallets per minute; without thresholds two busy whales produced 89 changes in
5 minutes, so it suggests recording at >=1% or >=$1,000 and surfacing at >=$5,000.

## Findings log (IST)

- **Nov 12, CTO:** position snapshots work across native perps, HIP-3 dexes and spot (above).
- **Nov 13, Backend Dev, Hyperliquid round trips:** `0x718cc7ee2ae2493ebf7d454316df6b61f4e1a868`,
  7 days of fills + funding. 3 closed `xyz:NVDA` perp trips, net +$14,519.80 (gross +$14,567.10,
  fees $77.00, funding +$29.69). Our gross matches Hyperliquid's `closedPnl` (+$14,564.41) to
  within $2.69 per trip. One spot position (`@272`) was open before the window.
- **Nov 13, Backend Dev, Polymarket Perps report:** `0xb10047d6a254b2ebb306d7a7d13bf59171ab6461`
  has no perps account ("not registered", "account not found"). Demo on leaderboard #1
  (`0x7930Ee98013FA1aEaC08872A88E677dc925aD132`): about $4.93M equity, 53 open positions, e.g.
  `ETH-USD SHORT 353.31, $682,927, entry 2020.58, +$30,871 (+22.6%), 5x`. A synthetic diff test
  with made-up changes caught all four kinds (opened, closed, resized, flipped).
- **Nov 17, ~11:37 AM, Hyperliquid check of `0x1f250Df59A777d61Cb8bd043c12970F3AFE4F925`:** BTC
  perps only. Short 1,500 BTC (~$97.1M notional), 40x cross, entry 64,756.9, liquidation ~66,869,
  uPnL ~-$4.4k. Equity ~$4.42M, all USDC margin, nothing withdrawable. Portfolio PnL: day -$2.10M,
  week +$3.77M, month +$3.18M, all-time -$35.0M on $16.6B volume. No HIP-3 or spot positions
  besides USDC.
  - **Correction (Nov 17, 11:42 AM re-run with `snapshot.ts`):** the earlier "976 fills in 48h,
    realized ~+$88.5k" was wrong. It came from `aggregateByTime: true`, which covered only the
    first 2000 raw fills (about 6 hours). Paginated, the last 48h has 19,567 raw fills, realized
    `closedPnl` +$210.7k, fees $197.5k. Same position at 11:42 AM: uPnL +$115.5k, equity $4.54M.
- **Nov 17, 11:42 AM, Polymarket Perps re-run:** leaderboard #1 now $4.97M equity, 53 open
  positions; `0xb100…6461` still not registered.

## Open questions (from #617, for the CTO and Bibhu)

1. How wallets get picked: hand-curated list, the leaderboard top, or both, and how to handle
   sub-accounts.
2. How often it runs, inside a rate limit shared with the market collector.
3. Where alerts go: a table only, an internal feed for Content Producer, or app users later.
4. Whether a big move attaches to the coin's entity as "who moved it" context.
5. Thresholds for recording versus surfacing a change.
6. New from this spike: whether Polymarket Perps wallets are in scope next to Hyperliquid.

## Next step

The CTO and Bibhu agree a spec on #617. Only then does a real package get built; this folder
stays as reference and can be deleted after that.
