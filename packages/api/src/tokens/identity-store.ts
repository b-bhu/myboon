// PostgREST-via-fetch store for public.token_identities, matching the shape
// of packages/api/src/polymarket/catalog/supabase-store.ts.

export interface TokenIdentityRow {
  assetId: string
  symbol: string
  name: string
  mint: string | null
  decimals: number | null
  category: 'crypto' | 'stablecoin' | 'equity' | 'commodity' | 'unknown'
  verified: boolean
  iconSourceUrl: string | null
  source: 'tokens' | 'seed'
  snapshotAt: string
}

export interface TokenIdentityStore {
  loadAll(): Promise<TokenIdentityRow[]>
  upsertMany(rows: TokenIdentityRow[]): Promise<void>
}

interface DbRow {
  asset_id: string
  symbol: string
  name: string
  mint: string | null
  decimals: number | null
  category: string
  verified: boolean
  icon_source_url: string | null
  source: string
  snapshot_at: string
}

type FetchLike = typeof fetch

const SELECT = 'asset_id,symbol,name,mint,decimals,category,verified,icon_source_url,source,snapshot_at'
const TABLE = 'token_identities'

export class SupabaseTokenIdentityStore implements TokenIdentityStore {
  private readonly restBaseUrl: string

  constructor(
    supabaseUrl: string,
    private readonly serviceRoleKey: string,
    private readonly fetchImpl: FetchLike = globalThis.fetch,
  ) {
    this.restBaseUrl = `${supabaseUrl.replace(/\/$/, '')}/rest/v1`
  }

  async loadAll(): Promise<TokenIdentityRow[]> {
    const params = new URLSearchParams({ select: SELECT })
    const rows = await this.readRows(params)
    return rows.map(mapRow)
  }

  async upsertMany(rows: TokenIdentityRow[]): Promise<void> {
    if (rows.length === 0) return

    const res = await this.fetchImpl(`${this.restBaseUrl}/${TABLE}?on_conflict=asset_id`, {
      method: 'POST',
      headers: {
        ...this.headers(),
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(rows.map(toDbRow)),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 1_000)
      throw new Error(`Supabase token_identities upsert failed: ${res.status}: ${detail}`)
    }
  }

  private async readRows(params: URLSearchParams): Promise<DbRow[]> {
    const res = await this.fetchImpl(`${this.restBaseUrl}/${TABLE}?${params.toString()}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 500)
      throw new Error(`Supabase token_identities read failed: ${res.status}: ${detail}`)
    }
    return res.json() as Promise<DbRow[]>
  }

  private headers(): Record<string, string> {
    return {
      apikey: this.serviceRoleKey,
      Authorization: `Bearer ${this.serviceRoleKey}`,
      'Content-Type': 'application/json',
    }
  }
}

function mapRow(row: DbRow): TokenIdentityRow {
  return {
    assetId: row.asset_id,
    symbol: row.symbol,
    name: row.name,
    mint: row.mint,
    decimals: row.decimals,
    category: row.category as TokenIdentityRow['category'],
    verified: row.verified,
    iconSourceUrl: row.icon_source_url,
    source: row.source as TokenIdentityRow['source'],
    snapshotAt: row.snapshot_at,
  }
}

function toDbRow(row: TokenIdentityRow): DbRow {
  return {
    asset_id: row.assetId,
    symbol: row.symbol,
    name: row.name,
    mint: row.mint,
    decimals: row.decimals,
    category: row.category,
    verified: row.verified,
    icon_source_url: row.iconSourceUrl,
    source: row.source,
    snapshot_at: row.snapshotAt,
  }
}
