import { mergeTokenRow, type TokenRegistryIncoming, type TokenRegistryRow } from './merge.js'

export interface TokenRegistryStore {
  getMany(mints: readonly string[]): Promise<Map<string, TokenRegistryRow>>
  upsertMany(rows: readonly TokenRegistryIncoming[]): Promise<void>
}

export class InMemoryTokenRegistryStore implements TokenRegistryStore {
  private readonly rows = new Map<string, TokenRegistryRow>()
  async getMany(mints: readonly string[]): Promise<Map<string, TokenRegistryRow>> {
    return new Map(mints.flatMap((mint) => this.rows.has(mint) ? [[mint, structuredClone(this.rows.get(mint)!)] as const] : []))
  }
  async upsertMany(rows: readonly TokenRegistryIncoming[]): Promise<void> {
    for (const row of rows) this.rows.set(row.mint, mergeTokenRow(this.rows.get(row.mint) ?? null, row))
  }
}

/** Uses the same service-role PostgREST pattern as the API's catalog stores. */
export class SupabaseTokenRegistryStore implements TokenRegistryStore {
  private readonly restBase: string
  constructor(url: string, private readonly serviceRoleKey: string, private readonly fetchImpl: typeof fetch = globalThis.fetch) {
    this.restBase = `${url.replace(/\/$/, '')}/rest/v1/token_registry`
  }
  async getMany(mints: readonly string[]): Promise<Map<string, TokenRegistryRow>> {
    if (!mints.length) return new Map()
    const params = new URLSearchParams({ select: '*', mint: `in.(${mints.map((mint) => `"${mint.replaceAll('"', '')}"`).join(',')})` })
    const rows = await this.request(`${this.restBase}?${params}`)
    return new Map((rows as TokenRegistryRow[]).map((row) => [row.mint, row]))
  }
  async upsertMany(rows: readonly TokenRegistryIncoming[]): Promise<void> {
    if (!rows.length) return
    // PostgREST cannot express the proposal's field-level conflict merge. Read,
    // merge in application code, then upsert; writes are idempotent but not serializable.
    const current = await this.getMany(rows.map((row) => row.mint))
    const updatedAt = new Date().toISOString()
    const merged = rows.map((row) => ({ ...mergeTokenRow(current.get(row.mint) ?? null, row), updated_at: updatedAt }))
    const response = await this.fetchImpl(`${this.restBase}?on_conflict=mint`, {
      method: 'POST', headers: this.headers({ 'content-type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify(merged), signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`Supabase token registry upsert failed: ${response.status}: ${(await response.text()).slice(0, 500)}`)
  }
  private async request(url: string): Promise<unknown> {
    const response = await this.fetchImpl(url, { headers: this.headers(), signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error(`Supabase token registry read failed: ${response.status}: ${(await response.text()).slice(0, 500)}`)
    return response.json()
  }
  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { apikey: this.serviceRoleKey, authorization: `Bearer ${this.serviceRoleKey}`, ...extra }
  }
}
