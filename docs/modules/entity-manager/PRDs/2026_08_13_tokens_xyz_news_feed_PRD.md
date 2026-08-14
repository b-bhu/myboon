# tokens.xyz News Feed Integration PRD

Status: draft for review
Date: 2026-08-13
Owner: myboon pipeline
Module: entity-manager
Branch: `feature/tokens-xyz-news-feed`
Scope: API-layer service only. Signal/research/entity-manager wiring is a
follow-up, tracked below, not part of this PRD's shipped scope.

## Purpose

Replace the news scout stage — five Hermes browser sessions scraping CoinDesk,
The Block, Decrypt, Unchained, and The Defiant — with `GET /v1/news/feed` on
tokens.xyz. The scout stage is fragile in a way that has nothing to do with
resources: several of those sites sit behind Cloudflare, browser sessions
fail against it regularly, and the scaffolding built to cope
(`readerFallbackUrl`, per-source `discoveryInstructions`, `failed_permanent`
vs `failed_transient` classification) exists only because we are asking an
LLM to scrape pages that actively resist it. A JSON API needs none of that.

This does not replace the researcher. Nothing in the tokens.xyz feed
verifies a claim, extracts entity hints, or separates what an article says
from what is independently true — that is the researcher's job today and
stays the researcher's job. See "Out of scope" below for why, and for the
open question this PRD does not resolve.

## Background: what we measured before building anything

Investigated directly against the live API (2026-08-13) rather than assumed:

- **No history.** `limit=50, source=news` spanned roughly 40 minutes of
  wall-clock news. There is no cursor, no page, no `since`. Every paging
  param tried (`page`, `offset`, `before`, `from`, `days`, `cursor`) was
  silently ignored — same first item back regardless. Anything published
  while nobody was polling is unrecoverable from this API.
- **Two content types in one array**, told apart only by `feed_source`:
  `coingecko` (published press — PANews, U.Today, FXStreet, Lookonchain,
  COINTURK, dozens of outlets we don't currently scrape) and `x` (posts from
  the single `@tokens` account — one company's timeline, not a search across
  X, and often promotional).
- **`related_coin_ids` is unreliable.** Reads like naive substring matching
  against a coin-id list. Real examples pulled live: a story about the MSCI
  China Index tagged `["2026-token", "composite", "micro", "test-4",
  "test-3"]`; a US tariff story tagged `["could"]`; a GameStop meme-token
  story tagged `["7-token", "binancecoin", "gamestop-3", "gme"]`. Usable as a
  weak prior. Never usable as entity truth.
- **Non-English content appears with no language filter** — e.g. a PANews
  item returned in Chinese during a plain `source=news` call.
- **The upstream fetches a wider candidate pool than it returns.** A 2-item
  `fetchPosts` call reported `xCandidates: 9` in its meta — confirms the API
  does its own ranking/trimming before applying our `limit`.

## What shipped in this PRD

Pure service layer, no HTTP routes, no collector wiring. Two files in
`packages/api/src/tokens/`, following the existing `jupiter-tokens.ts` /
`identity-service.ts` pattern of one file per upstream plus a shared
`types.ts` contract:

- **`types.ts`** (appended) — `TokensNewsArticle`, `TokensNewsPost`,
  `TokensNewsFeedMeta`, `TokensNewsFeedResult<T>`, `TokensNewsFetchOptions`.
  These are our shapes, not the upstream's — its field names (`title`,
  `posted_at`, `source_name`, `feed_source`, `related_coin_ids`) appear only
  inside `news-feed.ts`, so a rename on their side is a one-file fix here.
- **`news-feed.ts`** — the client. Two entry points, `fetchArticles()` and
  `fetchPosts()`, deliberately separate so they can become two independent
  collector processes on independent cadences later, matching how the
  operator described wanting to run this. Key read from
  `process.env.TOKENS_API_KEY` (root `.env`).

### Behavior decisions made while building

- **A missing API key throws**, it does not return an empty feed. An empty
  array is a legitimate answer (a token filter can genuinely match nothing),
  so a missing key must not be indistinguishable from that — a collector
  would otherwise log "no news today" and move on, silently blind.
- **4xx does not retry; 5xx and 429 do**, up to 2 retries with doubling
  backoff. A bad key or bad param fails identically every time; retrying it
  just burns the collector's time budget.
- **Timestamps normalized to one ISO form.** The two upstream halves format
  differently (`...Z` from CoinGecko, `...000Z` from X) — downstream
  fingerprinting should not need to know which half an item came from. An
  unparseable timestamp becomes `null`, never a fabricated date.
- **`feed_source` is filtered on our side too**, even though the `source`
  query param should already exclude the other half upstream. Belt and
  braces: a change on tokens.xyz's side cannot quietly start feeding tweets
  into an article collector.
- **`limit` is clamped, not passed through raw.** Asking for more than 50
  silently gets 50 back from the upstream with no error; we clamp first so a
  caller never believes it asked for more than it got.
- **`relatedCoinIds` is carried, not dropped**, but its docstring says
  UNTRUSTED with the real bad examples inline, so nobody downstream mistakes
  it for entity truth later.

### Verification

18 unit tests, all offline against fixtures captured from real responses
(`packages/api/src/tokens/news-feed.test.ts`). Additionally exercised live
against `https://api.tokens.xyz/v1/news/feed` for articles, posts, and
token-mode filtering (`coin_id=bitcoin&symbol=BTC&name=Bitcoin`) — all three
returned correctly normalized data.

```bash
cd packages/api && ./node_modules/.bin/tsx --test src/tokens/news-feed.test.ts
```

## Out of scope for this PRD

Everything past the API-layer client:

- Registering tokens.xyz as a source in `packages/collectors/src/news/config.ts`.
- The signal stage: turning `fetchArticles()`/`fetchPosts()` output into
  `NewsScoutCandidate` rows and running them through the existing
  `classifyNewsCandidate` dedupe/fingerprint path.
- The research stage: whether/how the researcher consumes tokens.xyz
  candidates, and the still-open question of external verification without
  credits (see Open Questions).
- Entity-manager wiring: whether `relatedCoinIds` becomes an entity-hint
  prior, and if so, how it's kept clearly separated from verified hints.
- Pausing or removing the five Hermes-scraped sources. `config.ts` already
  supports `status: 'paused'` per source with no code deletion required —
  intent is additive first (tokens.xyz as a sixth source, run alongside the
  existing five for comparison), then pause the scraped sources once output
  quality is confirmed side by side.
- Polling cadence for a live pipeline. Given the ~40-minute window measured
  above, an hourly interval (current `NEWS_RUNNER_INTERVAL_MS`) would drop
  most items; this needs a deliberate value once wiring begins, not a
  default carried over from the scout era.

## Open Questions

- **External research without credits.** The researcher currently browses
  articles directly via Hermes because per-call model/search credits aren't
  budgeted. `EXA_API_KEY` and `SERPER_API_KEY` exist in root `.env` but are
  unused anywhere in the codebase — unclear whether they have usable quota.
  Options discussed: (a) route research through Exa/Serper instead of a
  browser session, keeping Hermes for reasoning only; (b) research fewer
  candidates — skip verification for anything that doesn't look like a real
  event; (c) lean on cross-source corroboration in the tokens.xyz feed itself
  (same story reported by multiple outlets) as a free substitute for
  external verification on low-stakes items. Not decided.
- **Source identity for dedupe.** Should every tokens.xyz candidate share one
  `sourceId` (e.g. `tokens`), losing per-outlet tracking but simple, or should
  `sourceId` be derived from `source_name` per outlet, gaining real
  attribution but growing dynamically as CoinGecko adds outlets? Not decided.
- **Language filtering.** The feed has no language parameter and returned
  non-English content in testing. Decide whether to filter downstream or
  accept mixed-language candidates.

## Non-goals

- Building a cache layer. The operator was explicit this integration does
  not need one — the collectors, not this service, own any accumulation of
  history.
- Touching `packages/collectors/src/polymarket/`. That pipeline's status
  (broken since 2026-07-30, all processes currently stopped) is a separate,
  already-discussed decision and is not part of this PRD.
