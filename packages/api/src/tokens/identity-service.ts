// Token identity service: warm in-memory maps + pure synchronous resolution.
//
// Three-layer resolution, evaluated PER FIELD and triggered by an EMPTY
// field, never by HTTP status:
//   1. snapshot rows loaded from the token_identities table -> source 'snapshot'
//   2. checked-in seed (packages/api/src/tokens/seed/token-identities.seed.json) -> source 'static'
//   3. computed static fallback (symbol from the ref, fallbackLetter, iconUrl
//      null) -> source 'static'
// Layers 2 and 3 share the response's 'static' tag (see the frozen
// TokenIdentitySource union in types.ts) — the field is for production
// observability, not for enumerating internal layers.
//
// A snapshot row with an empty icon_source_url falls through, per field, to
// the seed layer and then the static layer for that field only — it does
// not discard the rest of the snapshot row.
//
// resolveRef is PURE AND SYNCHRONOUS: the request path must never await an
// upstream call. hydrateFromStore swaps the warm maps in place and never
// clears them on failure, so a cold or failed refresh degrades to whatever
// was last warm, never to nothing.

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { TokenIdentityRow, TokenIdentityStore } from './identity-store.js'
import { PERP_SYMBOL_TO_ASSET_ID, perpAssetId } from './perp-symbol-map.js'
import type { TokenIdentity, TokenIdentitySource } from './types.js'
import { canonicalAssetIdFor } from './canonical-asset-map.js'
import { categoryForSymbol, fallbackLetter, parseTokenRef } from './types.js'

interface SeedEntry {
  assetId: string
  symbol: string
  name: string
  mint: string | null
  decimals: number | null
  category: TokenIdentity['category']
  verified: boolean
  iconSourceUrl: string | null
  source: 'seed'
}

interface IdentityFields {
  assetId: string
  symbol: string
  name: string
  mint: string | null
  decimals: number | null
  category: TokenIdentity['category']
  verified: boolean
  iconSourceUrl: string | null
}

const SEED_PATH = fileURLToPath(new URL('./seed/token-identities.seed.json', import.meta.url))

function loadSeed(): SeedEntry[] {
  const raw = readFileSync(SEED_PATH, 'utf8')
  return JSON.parse(raw) as SeedEntry[]
}

// --- warm maps -------------------------------------------------------------
// Seed layer is pre-loaded at module init so resolution works before the
// first snapshot refresh ever runs.

const SEED_ENTRIES: SeedEntry[] = loadSeed()
const seedByAssetId = new Map<string, SeedEntry>()
const seedByMint = new Map<string, SeedEntry>()
for (const entry of SEED_ENTRIES) {
  seedByAssetId.set(entry.assetId, entry)
  if (entry.mint) seedByMint.set(entry.mint, entry)
}

let snapshotByAssetId = new Map<string, TokenIdentityRow>()
let snapshotByMint = new Map<string, TokenIdentityRow>()

/** Swap the warm snapshot maps in place. Never called with partial data on failure. */
function setSnapshotMaps(rows: TokenIdentityRow[]): void {
  const byAssetId = new Map<string, TokenIdentityRow>()
  const byMint = new Map<string, TokenIdentityRow>()
  for (const row of rows) {
    byAssetId.set(row.assetId, row)
    if (row.mint) byMint.set(row.mint, row)
  }
  snapshotByAssetId = byAssetId
  snapshotByMint = byMint
}

/**
 * Load snapshot rows from the store and swap the warm maps in place.
 * On failure, logs and leaves the existing maps untouched — a cold or
 * failed identity lookup degrades the icon, never the row.
 */
export async function hydrateFromStore(store: TokenIdentityStore): Promise<void> {
  try {
    const rows = await store.loadAll()
    setSnapshotMaps(rows)
  } catch (err) {
    console.error('[api] Token identity hydrate failed, keeping previous snapshot:', err instanceof Error ? err.message : err)
  }
}

/** Test-only escape hatch to seed the warm snapshot maps directly. */
export function __setSnapshotForTest(rows: TokenIdentityRow[]): void {
  setSnapshotMaps(rows)
}

/**
 * assetIds that have a checked-in icon file, read once at module init.
 *
 * Why bother: without this we advertise `/tokens/icon/<id>` for every asset,
 * including the ~11 that no source has artwork for. Each client then makes a
 * request that 404s before falling back to the letter box — a wasted round trip
 * per token per cold cache, and a console full of red that hides real errors.
 * Knowing what is on disk means we can say `iconUrl: null` up front and let the
 * client go straight to the letter box.
 *
 * A directory read at startup, not per request. Adding icons means re-running
 * `pnpm --filter @myboon/api run tokens:icons` and restarting — the same
 * restart that already picks up any other asset change.
 */
const AVAILABLE_ICON_ASSET_IDS: ReadonlySet<string> = loadAvailableIconIds()

function loadAvailableIconIds(): Set<string> {
  const ids = new Set<string>()
  try {
    // Sync + at-init is deliberate: resolveRef must stay pure and synchronous,
    // so it cannot await a filesystem check in the request path.
    const dir = new URL('../../assets/token-icons/', import.meta.url)
    for (const file of readdirSync(dir)) {
      const dot = file.lastIndexOf('.')
      if (dot > 0) ids.add(file.slice(0, dot).toLowerCase())
    }
  } catch {
    // No directory yet (fresh checkout before tokens:icons has run). Fall back
    // to advertising every icon: the proxy still resolves them from upstream,
    // so this degrades to the old behaviour rather than hiding every icon.
    return new Set<string>()
  }
  return ids
}

/**
 * The client-facing icon URL — always our own origin, never a third-party host.
 * Null when we have no artwork, so the client renders its letter box without a
 * doomed request first.
 */
function iconUrlFor(assetId: string | null): string | null {
  if (!assetId) return null
  // Empty set means "we do not know what is on disk" (see loadAvailableIconIds)
  // — advertise the URL and let the proxy try upstream.
  if (AVAILABLE_ICON_ASSET_IDS.size > 0 && !AVAILABLE_ICON_ASSET_IDS.has(assetId.toLowerCase())) {
    return null
  }
  return `/tokens/icon/${assetId}`
}

// --- per-field, three-layer merge ------------------------------------------

function resolveByAssetId(assetId: string): { fields: IdentityFields; source: TokenIdentitySource } | null {
  const snapshot = snapshotByAssetId.get(assetId)
  const seed = seedByAssetId.get(assetId)
  if (!snapshot && !seed) return null

  // Per-field fallthrough: snapshot -> seed. Never keyed on HTTP status —
  // an empty field on the snapshot row falls through to seed for that field.
  const symbol = nonEmpty(snapshot?.symbol) ?? nonEmpty(seed?.symbol) ?? assetId
  const name = nonEmpty(snapshot?.name) ?? nonEmpty(seed?.name) ?? symbol
  const mint = nonEmpty(snapshot?.mint) ?? nonEmpty(seed?.mint) ?? null
  const decimals = snapshot?.decimals ?? seed?.decimals ?? null
  const category = snapshot?.category ?? seed?.category ?? categoryForSymbol(symbol)
  const verified = snapshot?.verified ?? seed?.verified ?? false
  const iconSourceUrl = nonEmpty(snapshot?.iconSourceUrl) ?? nonEmpty(seed?.iconSourceUrl) ?? null

  // 'source' is frozen at the PRD's 4-value union (see types.ts) and exists
  // for production observability, not to enumerate internal layers. A hit
  // against the snapshot table is 'snapshot'; a hit against the checked-in
  // seed file with no table row loaded is 'static' — it is checked-in
  // static data, which is exactly what 'static' means for this field.
  const source: TokenIdentitySource = snapshot ? 'snapshot' : 'static'

  return {
    fields: { assetId, symbol, name, mint, decimals, category, verified, iconSourceUrl },
    source,
  }
}

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function staticFallback(raw: string, symbol: string): TokenIdentity {
  // An unresolved ref gets 'unknown', not categoryForSymbol(). That helper is
  // deliberately optimistic — it defaults to 'crypto' for anything it does not
  // recognize, which is the right call for a symbol we know is a listed market
  // but the wrong one here: we resolved nothing, so claiming a category would
  // be asserting something we do not know. 'unknown' exists for exactly this.
  return {
    key: raw,
    assetId: null,
    symbol,
    name: symbol,
    iconUrl: null,
    decimals: null,
    mint: null,
    verified: false,
    category: 'unknown',
    fallbackLetter: fallbackLetter(symbol),
    source: 'static',
  }
}

/**
 * Resolve a token ref to its identity. PURE AND SYNCHRONOUS — reads only
 * from the already-warm in-memory maps, never awaits an upstream call.
 */
export function resolveRef(ref: string): TokenIdentity {
  const parsed = parseTokenRef(ref)

  if (parsed.kind === 'mint') {
    const assetId = snapshotByMint.get(parsed.mint)?.assetId ?? seedByMint.get(parsed.mint)?.assetId ?? null
    if (assetId) {
      const resolved = resolveByAssetId(assetId)
      if (resolved) {
        return {
          key: ref,
          assetId: resolved.fields.assetId,
          symbol: resolved.fields.symbol,
          name: resolved.fields.name,
          iconUrl: iconUrlFor(resolved.fields.assetId),
          decimals: resolved.fields.decimals,
          mint: resolved.fields.mint ?? parsed.mint,
          verified: resolved.fields.verified,
          category: resolved.fields.category,
          fallbackLetter: fallbackLetter(resolved.fields.symbol),
          source: resolved.source,
        }
      }
    }
    // Unresolved mint: symbol falls back to a shortened mint, per the static layer.
    return staticFallback(ref, `${parsed.mint.slice(0, 4)}…${parsed.mint.slice(-4)}`)
  }

  if (parsed.kind === 'perp') {
    const assetId = perpAssetId(parsed.symbol)
    if (assetId) {
      const resolved = resolveByAssetId(assetId)
      if (resolved) {
        return {
          key: ref,
          assetId: resolved.fields.assetId,
          symbol: resolved.fields.symbol,
          name: resolved.fields.name,
          iconUrl: iconUrlFor(resolved.fields.assetId),
          decimals: null, // perp markets have no decimals
          mint: resolved.fields.mint,
          verified: resolved.fields.verified,
          category: resolved.fields.category,
          fallbackLetter: fallbackLetter(resolved.fields.symbol),
          source: resolved.source,
        }
      }
    }
    // Symbol not in the frozen map: static fallback using the ref's own symbol.
    return staticFallback(ref, parsed.symbol.replace(/-PERP$/i, ''))
  }

  // Unparseable ref: echo it back verbatim as both key and symbol.
  return staticFallback(ref, ref)
}

/**
 * Icon path helper for venue adapters (pacifica.ts / phoenix.ts) to call
 * directly. Returns `/tokens/icon/<assetId>` when the identity flag is on
 * and the perp symbol map hits, else null.
 */
export function perpIconPath(venueSymbol: string): string | null {
  if (process.env.TOKEN_IDENTITY_ENABLED !== 'true' && process.env.TOKEN_IDENTITY_ENABLED !== '1') return null
  const assetId = perpAssetId(venueSymbol)
  return assetId ? `/tokens/icon/${assetId}` : null
}

/**
 * Every ref the app could ask about, resolved — the whole catalog in one shot.
 *
 * This exists so the client makes ONE call instead of a per-screen resolve for
 * each venue's rows (which round-tripped for overlapping tokens: opening
 * Pacifica then Phoenix asked twice about BTC). Identity is effectively static
 * — a token's symbol, icon and decimals do not change — so the whole set is
 * cacheable for days behind an ETag, and a market row never waits on a network
 * call to render its icon.
 *
 * Covers both ref shapes the grammar allows: `perp:<symbol>` for every symbol
 * in the checked-in map, and `mint:<address>` for every seed mint. Resolution
 * runs through resolveRef so a catalog entry is byte-identical to what
 * /tokens/resolve would return for the same ref — one code path, no drift.
 */
export function resolveCatalog(): TokenIdentity[] {
  const refs: string[] = []
  for (const symbol of Object.keys(PERP_SYMBOL_TO_ASSET_ID)) refs.push(`perp:${symbol}`)
  for (const entry of SEED_ENTRIES) if (entry.mint) refs.push(`mint:${entry.mint}`)
  return refs.map(resolveRef)
}

/**
 * The single source of truth for resolving an assetId's upstream icon
 * source URL, for the icon proxy (tokens/icon-proxy.ts) to call directly.
 * Exposed standalone so the proxy does not need its own warm maps.
 *
 * Tier order, and the whole point of this function:
 *   1. the snapshot row under the registry's CANONICAL id (real Tokens icon)
 *   2. the snapshot row under our own seed slug
 *   3. the seed row (today: the venue's own icon)
 * Tier 1 is why canonicalAssetIdFor exists — the snapshot job writes rows
 * keyed by the registry's ids (`bitcoin`), while callers ask using our slugs
 * (`btc`). Without the translation every lookup skipped straight to tier 3.
 *
 * Returns null when no tier has a URL; the caller renders the letter box.
 */
export function iconSourceUrlForAssetId(assetId: string): string | null {
  const canonicalId = canonicalAssetIdFor(assetId)
  const canonicalSnapshot = canonicalId ? snapshotByAssetId.get(canonicalId) : undefined
  const snapshot = snapshotByAssetId.get(assetId)
  const seed = seedByAssetId.get(assetId)
  return (
    nonEmpty(canonicalSnapshot?.iconSourceUrl)
    ?? nonEmpty(snapshot?.iconSourceUrl)
    ?? nonEmpty(seed?.iconSourceUrl)
    ?? null
  )
}

// --- background refresh -----------------------------------------------------

export interface TokenIdentityRefreshConfig {
  store: TokenIdentityStore
  enabled: boolean
  intervalMs?: number
}

const DEFAULT_REFRESH_INTERVAL_MS = 60 * 60 * 1000 // 1h

let refreshInterval: ReturnType<typeof setInterval> | null = null
let initialRefreshTimeout: ReturnType<typeof setTimeout> | null = null

/**
 * Start the background snapshot-table refresh, mirroring
 * startMarketReadPolling in packages/api/src/polymarket/read/market-read.ts:
 * an initial 2s setTimeout plus a recurring setInterval. No-op when the
 * feature flag is off.
 */
export function startTokenIdentityRefresh(config: TokenIdentityRefreshConfig): void {
  if (!config.enabled) return
  if (refreshInterval) return

  const intervalMs = config.intervalMs
    ?? parseInterval(process.env.TOKENS_REFRESH_INTERVAL_MS)
    ?? DEFAULT_REFRESH_INTERVAL_MS

  const run = () => {
    void hydrateFromStore(config.store)
  }

  refreshInterval = setInterval(run, intervalMs)
  initialRefreshTimeout = setTimeout(run, 2_000)
  console.log(`[api] Token identity refresh started (every ${Math.round(intervalMs / 1000)}s)`)
}

export function stopTokenIdentityRefresh(): void {
  if (refreshInterval) clearInterval(refreshInterval)
  if (initialRefreshTimeout) clearTimeout(initialRefreshTimeout)
  refreshInterval = null
  initialRefreshTimeout = null
}

function parseInterval(value: string | undefined): number | null {
  if (!value) return null
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}
