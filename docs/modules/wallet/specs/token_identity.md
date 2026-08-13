# Token Identity

Status: living specification
Last amended: 2026-08-12
Owner: myboon Apps
Scope: how the system answers "what is this token" — symbol, name, icon,
decimals, category — for every venue, screen and subsystem

This document describes how the system works, not what work is outstanding.
Amend it when the model changes. Do not add issues, phases, or acceptance
criteria here — those belong in a PRD.

Companion change plan:
`docs/modules/wallet/PRDs/2026_08_11_token_identity_and_venue_adapters_PRD.md`.

## The model in one paragraph

A screen never decides what a token looks like. It asks the server for an
identity by *ref* and renders what comes back. The server resolves that ref
against warm in-memory maps — a checked-in seed for the curated set, a
Jupiter-backed mint cache for everything else — and always answers, even when it
knows nothing. Icons are served from our own origin so that the same token is
byte-identical across Pacifica, Phoenix and Meteora. Identity is a decoration on a market list, never
a precondition for one.

## The contract

`TokenIdentity` is frozen. Clients build against it directly, so field names and
types do not change without changing the PRD and every client together.

```ts
interface TokenIdentity {
  key: string;              // echo the caller's ref back verbatim
  assetId: string | null;   // canonical id; null when unresolved
  symbol: string;           // always present
  name: string;             // falls back to symbol
  iconUrl: string | null;   // ALWAYS our origin, never a third-party host
  decimals: number | null;  // null for perp markets — they have none
  mint: string | null;
  verified: boolean;
  category: 'crypto' | 'stablecoin' | 'equity' | 'commodity' | 'unknown';
  fallbackLetter: string;   // computed server-side so every client agrees
  source: 'snapshot' | 'venue' | 'helius' | 'static';
}
```

Two fields carry rules rather than data. `iconUrl` always points at our origin —
the client never learns where an icon came from, which is what makes the same
token match across venues. `source` exists so we can see in production which
venue is falling through to which layer.

### Ref grammar

A ref identifies a token one of two ways:

| Ref | Meaning |
|---|---|
| `mint:<base58>` | An SPL mint. |
| `perp:<symbol>` | A venue perp symbol. Accepted with or without a trailing `-PERP`, case preserved — `perp:kPEPE-PERP` and `perp:kPEPE` are the same ref. |

Anything else is well-formed input that resolves to nothing. `key` echoes the
caller's ref back exactly as sent, so a client can match responses to requests
without normalizing anything.

### Endpoints

| Route | Behavior |
|---|---|
| `GET /tokens/resolve?refs=<comma-separated>` | Max 100 refs. Returns `{ identities: TokenIdentity[] }` in input order, one entry per ref. |
| `POST /tokens/resolve` `{ refs: string[] }` | Max 500 refs. Same response. |
| `GET /tokens/icon/:assetId` | Icon bytes, content-type passed through from upstream (SVG or PNG). 404 when unknown or when the asset has no icon. |

`/tokens/resolve` never returns 4xx or 5xx for an unresolved ref. An unknown
token is a 200 with `assetId: null`, `iconUrl: null` and a computed
`fallbackLetter`. This matters more than it looks: the upstream registry returns
a *singleton* for anything outside its curated set — a well-formed response with
empty fields — so **fallback triggers on empty fields, never on HTTP status.**
Code that branches on a status code will silently render blanks.

## Resolution

Three layers, checked per field, in order:

1. **Seed** — the checked-in JSON at
   `packages/api/src/tokens/seed/token-identities.seed.json`. The curated set:
   every perp symbol both venues list, plus spot majors. Reports
   `source: 'static'`.
2. **Jupiter mint cache** — `jupiter-tokens.ts`, keyed by mint, filled on
   demand. The open-ended long tail: Meteora pool legs today, spot and meme
   lists later. Reports `source: 'venue'`.
3. **Static fallback** — symbol derived from the ref (a shortened mint for an
   unknown one), `fallbackLetter` computed, `iconUrl: null`.

**There is deliberately no database layer.** Identity for the curated set does
not change, so it is checked in. Identity for the long tail is far too large and
too fast-moving to snapshot — Meteora alone lists ~153,000 pools with new mints
daily — so it is fetched on demand and cached in memory. A table would only have
restated one of those two facts.

### Why two sources

The Tokens registry curates a few hundred assets by hand and does not accept
outside pull requests, so it will never cover a venue listing new mints daily.
Measured: it has icons for 34 of our 104 perp symbols and essentially none of
Meteora's pool tokens.

Jupiter *indexes* rather than curates. Measured against 40 real Meteora pool
mints it returned an icon for **40 of 40**, including tokens minted that week.

So each source does what it is actually good at: the registry for curated
identity and canonical grouping on perps and majors, Jupiter for everything
else.

`resolveRef()` is pure and synchronous. It reads only the warm maps and never
awaits an upstream call, which is what lets a market list render immediately.

### Categories

`categoryForSymbol()` is deliberately optimistic: an unrecognized symbol on a
listed market becomes `'crypto'`, because a listed perp almost certainly is one.
Metals and energy map to `'commodity'`, tokenized stocks to `'equity'`, stables
to `'stablecoin'`, and forex pairs and indices to `'unknown'` — the union has no
member for them and it is frozen.

An **unresolved** ref is the exception: it reports `'unknown'`, not the
optimistic default. We resolved nothing, so claiming a category would assert
something we do not know.

### Fallback letter

The first alphanumeric character of the display symbol, uppercased — `kPEPE`
gives `K`, `2Z` gives `2`. Computed server-side precisely so that a token
missing everywhere renders the *same* box with the *same* letter on every
screen, rather than three venues each inventing one.

## Perp symbols

`BTC-PERP` is not a mint and cannot resolve like one, so perps go through an
explicit checked-in map at `packages/api/src/tokens/perp-symbol-map.ts`
(`PERP_SYMBOL_TO_ASSET_ID`, plus `perpAssetId()` which strips the `-PERP` suffix
and matches case-insensitively).

**Perps resolve through this map only — never through fuzzy search.** Searching
the stripped ticker works for majors and then, on some mid-cap ticker collision,
shows a confidently wrong logo. A wrong logo is worse than no logo. A symbol
missing from the map falls through to the letter box, and adding one is a
one-line change.

Denominated symbols are why the heuristic cannot be trusted: stripping `k` from
`kPEPE` yields `KPEPE`, which resolves to nothing. `kPEPE`, `kBONK` and `kSHIB`
map explicitly to their underlying assets.

## Icons

Two routes, both serving bytes from our own origin:

| Route | Source |
|---|---|
| `GET /tokens/icon/:assetId` | Checked-in files under `packages/api/assets/token-icons/` — read from disk, no network call. |
| `GET /tokens/icon/mint/:mint` | Fetched on demand from whatever host the mint's metadata names, then cached. |

Curated icons are **files on disk**, not a live dependency. A token's logo does
not change, so `tokens:icons` downloads ~100 of them once (2.9 MB) and the API
serves them in single-digit milliseconds with no upstream involved.

Long-tail icons cannot work that way — the set is unbounded — so they are
proxied. That proxying is the point, not an implementation detail: those images
live on IPFS, Arweave, Irys and assorted launchpad CDNs (8+ distinct hosts
across 40 sampled Meteora pool tokens). Measured on real tokens, one icon took
**5.4 s** from a slow IPFS gateway and another was a **907 KB** full-resolution
PNG. Fetching those per device would mean slow, broken-looking rows and wasted
mobile data; fetched once and cached, the second request served in **1.9 ms**.

Bytes cache for a week; misses negative-cache for an **hour**, and transient
network failures for a **minute** — a 404 is an answer, a timeout is not.

`iconUrl` is `null` when we have no artwork at all, so the client renders its
letter box without first making a request that is certain to fail.

Upstream icon URLs are stored **exact-cased**. Pacifica's icon CDN is
case-sensitive — `kPEPE.svg` serves, `KPEPE.svg` 404s — so any code path that
uppercases a symbol before building an icon URL breaks the denominated markets.

## What this service does not own

**Prices, quotes, perp market data, pool data.** The registry's prices are
cached third-party data, further from execution than what we already have.
Showing a registry spot price next to a perp mark price is a correctness bug,
not a cosmetic one. `TokenIdentity` has no price field, and it must not grow
one — that absence is the enforcement mechanism.

## Refreshing the icons

Icons are bytes on disk, fetched once by a script rather than a running job:

```bash
TOKENS_API_KEY=... pnpm --filter @myboon/api run tokens:icons
```

Per asset it takes the best available artwork — the Tokens registry's canonical
logo where it has one (34 today), the venue's otherwise — and writes it to
`packages/api/assets/token-icons/`. Existing files are skipped unless `--force`
is passed. Re-run it after adding markets to the seed, then restart the API so
it re-reads the directory.

Long-tail icons need no script: they are fetched through the proxy on first
request and cached in memory.

## Configuration

| Name | Meaning |
|---|---|
| `TOKEN_IDENTITY_ENABLED` | The one feature flag. Default **off**. |
| `TOKENS_API_KEY` | The one env var for upstream access. Optional. |
| `TOKENS_REFRESH_INTERVAL_MS` | Warm-map refresh cadence. Defaults to one hour. |
| `TOKENS_SNAPSHOT_INTERVAL_MS` | Snapshot job cadence. Defaults to 24 hours. |

With the flag **off** the app keeps working: `/tokens/resolve` still answers
well-formed identities with `assetId: null` and `iconUrl: null`,
`/tokens/icon/*` returns 404, and the venues serve their own legacy icon paths.
Degradation is the default path whenever the identity map is empty, so no
screen needs a special branch for it.

That table is the whole surface, and deliberately so. There is **no client-side
kill switch** — a second knob could disagree with the server's, which is the
exact failure "one feature flag and one env var" exists to prevent. The client
degrades from what the server sends rather than deciding for itself.

Note the flag is a **runtime** branch, not a boot-time one: the routes are
always mounted and consult the flag per request, so flipping it does not
require a redeploy to take effect.

## Rules that are easy to break

- **Identity never blocks a market list.** Resolve on the background refresh and
  read from the warm map. A cold or failed lookup degrades the icon, never the
  row.
- **Fall back on empty fields, not on status codes.** Unresolved is a 200.
- **Never fuzzy-search a perp symbol.**
- **Never uppercase a symbol before building an icon URL.**
- **Never let a third-party icon host reach the client.**
- **Never add a price field to `TokenIdentity`.**

## Known limits

**Caches are per-process.** The Jupiter mint cache and the icon byte cache are
module-level `Map`s. The curated set is unaffected — seed and icon files are on
disk, so every instance has them — but on a multi-instance deploy the long-tail
caches warm independently and upstream call volume multiplies by instance count.
Shared caching (Redis, or a CDN in front of the icon routes) is the fix, and it
becomes worth doing when either instance count or long-tail traffic grows. Not
before.

**Nothing here is built for fast-moving data.** Identity is treated as static:
multi-day catalog caching, week-long icon TTLs, a directory read at boot. That
is correct for what a token *is*, and wrong for anything that changes by the
minute. A meme-discovery or spot feed will need shorter TTLs and probably a push
channel; that is a separate design, not a tuning exercise on this one.

**Icon availability is not identity availability.** Jupiter covered 40 of 40
sampled Meteora pool mints, but a token minted seconds ago may not be indexed
yet. Those cache as a miss for ten minutes and retry, so a brand-new token can
show a letter box briefly before its icon appears.

Portfolio and limit-order legs from Meteora's upstream omit `decimals`. Those
now carry `null` rather than a fabricated `0`; any math downstream must resolve
real decimals through a `mint:` ref rather than trusting the venue payload.
