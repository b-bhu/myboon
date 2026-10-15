/** The frozen source values used by TokenIdentityV1. */
export type TokenIdentitySource = 'snapshot' | 'venue' | 'helius' | 'static'

/** Version 1 shared token identity shape. Keep aligned with the API contract. */
export interface TokenIdentityV1 {
  key: string
  assetId: string | null
  symbol: string
  name: string
  iconUrl: string | null
  decimals: number | null
  mint: string | null
  verified: boolean
  category: 'crypto' | 'stablecoin' | 'equity' | 'commodity' | 'unknown'
  fallbackLetter: string
  source: TokenIdentitySource
}

/**
 * Resolve response envelope. `partial` is true only when refs were skipped
 * because of the per-request upstream cap, the time budget, or the rate
 * limiter; `unresolved` lists exactly those refs. Confirmed misses are not
 * partial. Both fields are always present. Only GET/POST /tokens/resolve can
 * return partial results.
 */
export type TokenResolveResponseV1 = {
  v: 1
  identities: TokenIdentityV1[]
  partial: boolean
  unresolved: string[]
}

/** Token catalog response envelope; catalog responses are never partial. */
export type TokenCatalogResponseV1 = {
  v: 1
  identities: TokenIdentityV1[]
}

/** Checks the versioned response envelope without validating identity fields. */
export function isTokenResolveResponseV1(x: unknown): x is TokenResolveResponseV1 {
  if (typeof x !== 'object' || x === null) return false

  const response = x as Record<string, unknown>
  return response.v === 1
    && Array.isArray(response.identities)
    && typeof response.partial === 'boolean'
    && Array.isArray(response.unresolved)
}
