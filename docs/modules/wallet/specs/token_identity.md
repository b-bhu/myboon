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
against a warm in-memory map — built from a nightly snapshot table layered over
a checked-in seed file — and always answers, even when it knows nothing. Icons
are served from our own origin so that the same token is byte-identical across
Pacifica, Phoenix and Meteora. Identity is a decoration on a market list, never
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

1. **Snapshot** — a row in `public.token_identities`, written by the nightly job.
2. **Seed** — the checked-in JSON at `packages/api/src/tokens/seed/token-identities.seed.json`.
3. **Static fallback** — symbol derived from the ref, `fallbackLetter` computed,
   `iconUrl: null`.

Per-field is the important part. A snapshot row with a null `icon_source_url`
does not shadow the seed's icon; that one field falls through while the rest of
the row is used.

Layers 2 and 3 both report `source: 'static'`. The union is frozen and exists
for observability, not to enumerate internal layers — a seed hit *is* static
checked-in data. If seed-vs-nothing needs distinguishing for debugging, use a
log line or a non-contract field, never a new `source` value.

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

The proxy is keyed on `assetId` and fetches from the upstream URL recorded for
that asset. Icon bytes cache for a week; misses negative-cache for an **hour**,
not a day, so a newly listed token is not broken for a full day.

Upstream icon URLs are stored **exact-cased**. Pacifica's icon CDN is
case-sensitive — `kPEPE.svg` serves, `KPEPE.svg` 404s — so any code path that
uppercases a symbol before building an icon URL breaks the denominated markets.

Venue-supplied icons remain a second-tier fallback rather than being deleted.
Meteora lists brand-new tokens constantly and most will be unresolved; a
slightly-off icon beats no icon on a pool row.

## What this service does not own

**Prices, quotes, perp market data, pool data.** The registry's prices are
cached third-party data, further from execution than what we already have.
Showing a registry spot price next to a perp mark price is a correctness bug,
not a cosmetic one. `TokenIdentity` has no price field, and it must not grow
one — that absence is the enforcement mechanism.

## The snapshot job

A nightly job (`packages/api/src/tokens/snapshot-job.ts`, entry point
`run-snapshot.ts`) writes into `public.token_identities`.

It runs in two modes. With `TOKENS_API_KEY` set it pulls the upstream curated
lists, resolves the known mint universe, fetches per-asset icon and category,
and upserts rows tagged `source: 'tokens'`. Without a key it upserts the
checked-in seed and logs that the upstream pull was skipped — so the whole
system is buildable, runnable and testable with no upstream access at all.

The job **never deletes rows**. A bad or empty upstream response degrades to
stale-but-correct data rather than to nothing.

Run it once by hand with:

```bash
TOKENS_SNAPSHOT_RUN_ONCE=1 pnpm --filter @myboon/api run tokens:snapshot
```

Apply the table migration with `pnpm dlx supabase db push`.

The table row's own `source` column (`'tokens' | 'seed'`) records table
provenance and is unrelated to the `TokenIdentity.source` response field.

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

Every cache in `packages/api` is a module-level `Map`, which is per-process. On
a multi-instance deploy the hit rate collapses and upstream call volume
multiplies by instance count. The nightly-snapshot design mostly sidesteps this
for identity data, but the icon proxy needs a CDN in front of it before it
matters.

Coverage of the long tail is thin by design. The upstream registry curates
rather than indexes, so newly listed tokens resolve to nothing and render the
letter box or the venue's own icon. That is the intended behavior, not a gap to
close by loosening the matching rules.

Portfolio and limit-order legs from Meteora's upstream omit `decimals`. Those
now carry `null` rather than a fabricated `0`; any math downstream must resolve
real decimals through a `mint:` ref rather than trusting the venue payload.
