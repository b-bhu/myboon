// Nightly token identity snapshot job. Pure function, no module-level state,
// so it can be driven by the CLI entrypoint (run-snapshot.ts) or by tests
// with a mocked fetchImpl and store.
//
// Seed-mode upsert ALWAYS runs (the checked-in seed is re-applied every run
// so a table row's fields never regress behind a stale snapshot). When an
// apiKey is present, the job additionally pulls from the Tokens API and
// upserts those rows with source 'tokens' — which, keyed by asset_id
// upsert-merge, take priority over the seed rows written in the same run
// (Tokens data is applied after the seed layer).
//
// EMPTY-FIELD TOLERANCE: Tokens returns a 200 singleton for anything outside
// its curated registry (imageUrl: null, empty stats). That is not treated as
// an error — it upserts a row with icon_source_url null, and the identity
// service's per-field fallthrough (identity-service.ts) covers the gap at
// serve time. This job NEVER deletes rows.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { TokenIdentityRow, TokenIdentityStore } from './identity-store.js'

interface SeedEntry {
  assetId: string
  symbol: string
  name: string
  mint: string | null
  decimals: number | null
  category: TokenIdentityRow['category']
  verified: boolean
  iconSourceUrl: string | null
  source: 'seed'
}

const SEED_PATH = fileURLToPath(new URL('./seed/token-identities.seed.json', import.meta.url))

function defaultSeedLoader(): SeedEntry[] {
  return JSON.parse(readFileSync(SEED_PATH, 'utf8')) as SeedEntry[]
}

type FetchLike = typeof fetch

const TOKENS_API_BASE = process.env.TOKENS_API_BASE || 'https://api.tokens.xyz/v1'

// Curated lists pulled for the snapshot. Kept in sync with the Tokens API's
// documented curated-list categories.
const CURATED_LISTS = ['majors', 'lsts', 'currencies', 'rwas', 'etfs', 'metals', 'stocks'] as const

interface TokensAssetPayload {
  id?: string
  assetId?: string
  symbol?: string
  name?: string
  mint?: string | null
  decimals?: number | null
  category?: string | null
  verified?: boolean | null
  imageUrl?: string | null
  iconUrl?: string | null
}

interface RunTokenSnapshotOptions {
  apiKey?: string | null
  store: TokenIdentityStore
  fetchImpl?: FetchLike
  seed?: SeedEntry[]
  /** Mints to resolve via /v1/assets/resolve, in addition to curated lists. Optional — defaults to []. */
  knownMints?: string[]
}

export interface RunTokenSnapshotResult {
  seedRowsUpserted: number
  tokensRowsUpserted: number
  tokensCallsFailed: number
}

function toRow(entry: SeedEntry): TokenIdentityRow {
  return {
    assetId: entry.assetId,
    symbol: entry.symbol,
    name: entry.name,
    mint: entry.mint,
    decimals: entry.decimals,
    category: entry.category,
    verified: entry.verified,
    iconSourceUrl: entry.iconSourceUrl,
    source: 'seed',
    snapshotAt: new Date().toISOString(),
  }
}

function mapTokensAsset(asset: TokensAssetPayload): TokenIdentityRow | null {
  const assetId = asset.assetId ?? asset.id
  if (!assetId) return null

  const symbol = nonEmpty(asset.symbol) ?? assetId
  return {
    assetId,
    symbol,
    name: nonEmpty(asset.name) ?? symbol,
    mint: nonEmpty(asset.mint) ?? null,
    decimals: typeof asset.decimals === 'number' ? asset.decimals : null,
    category: normalizeCategory(asset.category),
    verified: Boolean(asset.verified),
    // EMPTY-FIELD TOLERANCE: a 200 singleton with imageUrl null upserts
    // icon_source_url null — the serving layer falls through, this job does
    // not treat it as a failure.
    iconSourceUrl: nonEmpty(asset.imageUrl) ?? nonEmpty(asset.iconUrl) ?? null,
    source: 'tokens',
    snapshotAt: new Date().toISOString(),
  }
}

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function normalizeCategory(value: string | null | undefined): TokenIdentityRow['category'] {
  const allowed: TokenIdentityRow['category'][] = ['crypto', 'stablecoin', 'equity', 'commodity', 'unknown']
  return allowed.includes(value as TokenIdentityRow['category']) ? (value as TokenIdentityRow['category']) : 'unknown'
}

async function fetchCuratedList(
  fetchImpl: FetchLike,
  apiKey: string,
  list: string,
): Promise<TokenIdentityRow[]> {
  const res = await fetchImpl(`${TOKENS_API_BASE}/assets/curated?list=${encodeURIComponent(list)}`, {
    headers: { 'x-api-key': apiKey },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`Tokens curated list ${list} failed: ${res.status}`)
  // The live API wraps the list in `assets` (verified against
  // GET /v1/assets/curated?list=majors — see the spec). `data` is accepted as a
  // defensive alias only. Reading the wrong key here is silent: the request
  // 200s, the list parses as empty, and the job reports success having written
  // nothing — which is exactly what happened before this was verified with a
  // real key.
  const body = await res.json() as
    | { assets?: TokensAssetPayload[]; data?: TokensAssetPayload[] }
    | TokensAssetPayload[]
  const assets = Array.isArray(body) ? body : (body.assets ?? body.data ?? [])
  if (assets.length === 0) {
    console.warn(`[api] Token snapshot: curated list ${list} returned no assets — check the response shape`)
  }
  return assets.map(mapTokensAsset).filter((row): row is TokenIdentityRow => row !== null)
}

async function fetchResolveMint(
  fetchImpl: FetchLike,
  apiKey: string,
  mint: string,
): Promise<TokenIdentityRow | null> {
  const res = await fetchImpl(`${TOKENS_API_BASE}/assets/resolve?mint=${encodeURIComponent(mint)}`, {
    headers: { 'x-api-key': apiKey },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`Tokens resolve mint ${mint} failed: ${res.status}`)
  // Live shape: { assetId, resolvedBy, mint, asset: {...}, variant: {...} }.
  // The nested `asset` carries symbol/name/category; the top-level `assetId` is
  // the canonical id. Note an UNCURATED mint still 200s here with a singleton
  // id like `solana-<mint>` and no imageUrl — that is a miss, not a hit, and
  // mapTokensAsset leaves iconSourceUrl null so the serving layer falls through.
  const body = await res.json() as { asset?: TokensAssetPayload; assetId?: string } & TokensAssetPayload
  const asset = body.asset ?? body
  return mapTokensAsset({ ...asset, assetId: asset.assetId ?? body.assetId })
}

async function fetchAssetById(
  fetchImpl: FetchLike,
  apiKey: string,
  assetId: string,
): Promise<TokenIdentityRow | null> {
  const res = await fetchImpl(`${TOKENS_API_BASE}/assets/${encodeURIComponent(assetId)}`, {
    headers: { 'x-api-key': apiKey },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`Tokens asset ${assetId} failed: ${res.status}`)
  // Live shape: { asset: { assetId, name, symbol, category, imageUrl, ... } }.
  const body = await res.json() as { asset?: TokensAssetPayload } & TokensAssetPayload
  return mapTokensAsset(body.asset ?? body)
}

/**
 * Run one snapshot pass: seed-mode upsert always, plus a Tokens API pull
 * when apiKey is present. Never deletes rows — a token disappearing from a
 * curated list or the seed file just stops being refreshed, it does not get
 * removed from the table.
 */
export async function runTokenSnapshot(options: RunTokenSnapshotOptions): Promise<RunTokenSnapshotResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const seed = options.seed ?? defaultSeedLoader()

  const seedRows = seed.map(toRow)
  await options.store.upsertMany(seedRows)

  const result: RunTokenSnapshotResult = {
    seedRowsUpserted: seedRows.length,
    tokensRowsUpserted: 0,
    tokensCallsFailed: 0,
  }

  if (!options.apiKey) return result

  const apiKey = options.apiKey
  const tokensRows = new Map<string, TokenIdentityRow>()

  for (const list of CURATED_LISTS) {
    try {
      const rows = await fetchCuratedList(fetchImpl, apiKey, list)
      for (const row of rows) tokensRows.set(row.assetId, row)
    } catch (err) {
      result.tokensCallsFailed += 1
      console.error(`[api] Token snapshot: curated list ${list} failed:`, err instanceof Error ? err.message : err)
    }
  }

  for (const mint of options.knownMints ?? []) {
    try {
      const row = await fetchResolveMint(fetchImpl, apiKey, mint)
      if (row) tokensRows.set(row.assetId, row)
    } catch (err) {
      result.tokensCallsFailed += 1
      console.error(`[api] Token snapshot: resolve mint ${mint} failed:`, err instanceof Error ? err.message : err)
    }
  }

  // Backfill icon/category detail for any asset id gathered above via /v1/assets/:id.
  for (const assetId of [...tokensRows.keys()]) {
    try {
      const detail = await fetchAssetById(fetchImpl, apiKey, assetId)
      if (detail) tokensRows.set(assetId, detail)
    } catch (err) {
      result.tokensCallsFailed += 1
      console.error(`[api] Token snapshot: asset detail ${assetId} failed:`, err instanceof Error ? err.message : err)
    }
  }

  const rows = [...tokensRows.values()]
  if (rows.length > 0) {
    await options.store.upsertMany(rows)
    result.tokensRowsUpserted = rows.length
  }

  return result
}
