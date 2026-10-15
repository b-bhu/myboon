export type TokenSource = 'seed' | 'jupiter' | 'meteora' | string
export interface TokenRegistryRow {
  mint: string
  symbol: string | null
  name: string | null
  decimals: number | null
  icon_source_url: string | null
  verified: boolean
  sources: Record<string, string>
  upstream_seen_at: string | null
  updated_at?: string
}
export type TokenRegistryIncoming = Omit<TokenRegistryRow, 'updated_at'> & { updated_at?: string }
const rank = (source: string | undefined): number => source === 'seed' ? 3 : source === 'jupiter' ? 2 : source === 'meteora' ? 1 : 0

/** Mirrors the field guards and provenance behavior in the approved SQL. */
export function mergeTokenRow(stored: TokenRegistryRow | null, incoming: TokenRegistryIncoming): TokenRegistryRow {
  if (!stored) return { ...incoming, sources: { ...incoming.sources } }
  const olderTime = stored.upstream_seen_at ? Date.parse(stored.upstream_seen_at) : null
  const newTime = incoming.upstream_seen_at ? Date.parse(incoming.upstream_seen_at) : null
  const take = (field: 'symbol' | 'name' | 'decimals' | 'icon_source_url') => incoming[field] !== null
    && (stored[field] === null || olderTime === null || (newTime !== null && newTime > olderTime))
  const sources = { ...stored.sources }
  for (const [field, value] of Object.entries(incoming.sources)) {
    if (field === 'verified' ? rank(value) >= rank(stored.sources.verified)
      : ['symbol', 'name', 'decimals', 'icon_source_url'].includes(field) ? take(field as 'symbol' | 'name' | 'decimals' | 'icon_source_url')
        : true) sources[field] = value
  }
  const verifiedFromIncoming = rank(incoming.sources.verified) >= rank(stored.sources.verified)
  let upstreamSeenAt = stored.upstream_seen_at
  if (upstreamSeenAt === null) upstreamSeenAt = incoming.upstream_seen_at
  else if (incoming.upstream_seen_at !== null && Date.parse(incoming.upstream_seen_at) > Date.parse(upstreamSeenAt)) upstreamSeenAt = incoming.upstream_seen_at
  return {
    mint: incoming.mint,
    symbol: take('symbol') ? incoming.symbol : stored.symbol,
    name: take('name') ? incoming.name : stored.name,
    decimals: take('decimals') ? incoming.decimals : stored.decimals,
    icon_source_url: take('icon_source_url') ? incoming.icon_source_url : stored.icon_source_url,
    verified: verifiedFromIncoming ? incoming.verified : stored.verified,
    sources,
    upstream_seen_at: upstreamSeenAt,
    updated_at: incoming.updated_at ?? stored.updated_at,
  }
}
