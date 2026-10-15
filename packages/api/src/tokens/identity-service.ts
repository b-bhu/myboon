// Token identity service: checked-in seed data, a legacy warm Jupiter map, and
// pure synchronous resolution. When TOKEN_REGISTRY_ENABLED is on, app wiring
// supplies a bounded registry lookup to resolveRef; when off, the legacy
// seed/Jupiter path remains unchanged.
//
// resolveRef is PURE AND SYNCHRONOUS: request handling never waits on Jupiter.
// All upstream warming happens before resolution and is best-effort.

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PERP_SYMBOL_TO_ASSET_ID, perpAssetId } from './perp-symbol-map.js'
import type { TokenIdentity, TokenIdentitySource } from './types.js'
import { canonicalAssetIdFor } from './canonical-asset-map.js'
import { getCachedJupiterToken, warmJupiterTokens } from './jupiter-tokens.js'
import { categoryForSymbol, fallbackLetter, parseTokenRef } from './types.js'
import type { TokenRegistryRow } from './registry/merge.js'

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
// Seed layer is pre-loaded at module init — no warm-up, no first-request stall.

const SEED_ENTRIES: SeedEntry[] = loadSeed()
const seedByAssetId = new Map<string, SeedEntry>()
const seedByMint = new Map<string, SeedEntry>()
for (const entry of SEED_ENTRIES) {
  seedByAssetId.set(entry.assetId, entry)
  if (entry.mint) seedByMint.set(entry.mint, entry)
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
  const seed = seedByAssetId.get(assetId)
  if (!seed) return null

  const symbol = nonEmpty(seed.symbol) ?? assetId
  return {
    fields: {
      assetId,
      symbol,
      name: nonEmpty(seed.name) ?? symbol,
      mint: nonEmpty(seed.mint) ?? null,
      decimals: seed.decimals ?? null,
      category: seed.category ?? categoryForSymbol(symbol),
      verified: seed.verified ?? false,
      iconSourceUrl: nonEmpty(seed.iconSourceUrl) ?? null,
    },
    // Checked-in static data — exactly what 'static' means in the frozen
    // TokenIdentitySource union (see types.ts).
    source: 'static',
  }
}

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

/** Display stand-in for a mint we know nothing about yet: `So11…1112`. */
function shortMint(mint: string): string {
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`
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
export function resolveRef(
  ref: string,
  opts?: { registryRowForMint?: (mint: string) => TokenRegistryRow | null | undefined },
): TokenIdentity {
  const parsed = parseTokenRef(ref)

  if (parsed.kind === 'mint') {
    // In registry mode this is the bounded LRU view; do not fall through into
    // the legacy unbounded Jupiter map when the registry has a miss.
    if (opts?.registryRowForMint) {
      const row = opts.registryRowForMint(parsed.mint)
      // Checked-in seed data remains authoritative for curated mints, even
      // when the bounded registry has not loaded it or has an upstream row.
      const seededAssetId = seedByMint.get(parsed.mint)?.assetId
      const seeded = seededAssetId ? resolveByAssetId(seededAssetId) : null
      if (seeded) {
        return {
          key: ref, assetId: seeded.fields.assetId, symbol: seeded.fields.symbol,
          name: seeded.fields.name, iconUrl: iconUrlFor(seeded.fields.assetId),
          decimals: seeded.fields.decimals, mint: seeded.fields.mint ?? parsed.mint,
          verified: seeded.fields.verified, category: seeded.fields.category,
          fallbackLetter: fallbackLetter(seeded.fields.symbol), source: seeded.source,
        }
      }
      if (row) {
        const symbol = nonEmpty(row.symbol) ?? shortMint(parsed.mint)
        return {
          key: ref, assetId: null, symbol, name: nonEmpty(row.name) ?? symbol,
          iconUrl: row.icon_source_url ? `/tokens/icon/mint/${parsed.mint}` : null,
          decimals: row.decimals, mint: parsed.mint, verified: row.verified,
          category: 'crypto', fallbackLetter: fallbackLetter(symbol), source: row.sources.symbol === 'seed' ? 'static' : 'venue',
        }
      }
      return staticFallback(ref, shortMint(parsed.mint))
    }
    const assetId = seedByMint.get(parsed.mint)?.assetId ?? null
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
    // Legacy mode: read the old warm Jupiter map. The lookup itself happens
    // in warmJupiterTokens, never synchronously in this function.
    const jupiter = getCachedJupiterToken(parsed.mint)
    if (jupiter) {
      const symbol = nonEmpty(jupiter.symbol) ?? shortMint(parsed.mint)
      return {
        key: ref,
        assetId: null, // no canonical registry id — identity is Jupiter's, keyed by mint
        symbol,
        name: nonEmpty(jupiter.name) ?? symbol,
        // Icon is served from OUR origin keyed on the mint; the upstream URL
        // (IPFS/Arweave/a launchpad CDN) never reaches a client.
        iconUrl: jupiter.iconUrl ? `/tokens/icon/mint/${parsed.mint}` : null,
        decimals: jupiter.decimals,
        mint: parsed.mint,
        verified: jupiter.verified,
        category: 'crypto',
        fallbackLetter: fallbackLetter(symbol),
        source: 'venue',
      }
    }

    // Nothing anywhere yet: shortened mint + letter box, and the next warm pass
    // may fill it in.
    return staticFallback(ref, shortMint(parsed.mint))
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
 * Upstream icon URL for an arbitrary mint, from the warm Jupiter cache.
 * Used by GET /tokens/icon/mint/:mint — the proxy fetches these bytes once and
 * serves them from our origin, so the third-party host never reaches a client.
 */
export function iconSourceUrlForMint(mint: string): string | null {
  return getCachedJupiterToken(mint)?.iconUrl ?? null
}

/**
 * Look up any mints we do not know yet, so the NEXT resolve for them returns
 * real identity. Await it before resolving if you want icons on first paint;
 * fire-and-forget if you would rather the rows render immediately and fill in.
 *
 * Mint-generic on purpose: Meteora pool legs today, spot and meme lists later.
 */
export async function warmMintIdentities(mints: readonly string[]): Promise<void> {
  if (mints.length === 0) return
  await warmJupiterTokens(mints)
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
  return refs.map((ref) => resolveRef(ref))
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
  const canonicalSeed = canonicalId ? seedByAssetId.get(canonicalId) : undefined
  const seed = seedByAssetId.get(assetId)
  return nonEmpty(canonicalSeed?.iconSourceUrl) ?? nonEmpty(seed?.iconSourceUrl) ?? null
}




/** Registry seed projection; kept separate from the frozen client TokenIdentity. */
export function tokenRegistrySeeds() {
  return SEED_ENTRIES.filter((entry) => entry.mint).map((entry) => ({
    mint: entry.mint!, symbol: entry.symbol, name: entry.name, decimals: entry.decimals,
    icon_source_url: entry.iconSourceUrl, verified: entry.verified,
    sources: { symbol: 'seed', name: 'seed', decimals: 'seed', ...(entry.iconSourceUrl ? { icon_source_url: 'seed' } : {}), verified: 'seed' },
    upstream_seen_at: null,
  }))
}

