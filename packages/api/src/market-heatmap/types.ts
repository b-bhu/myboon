export const MARKET_HEATMAP_INTERVALS = ['5m', '1h', '6h', '24h'] as const

export type MarketHeatmapInterval = typeof MARKET_HEATMAP_INTERVALS[number]
export type MarketHeatmapStatus = 'ready' | 'partial' | 'stale' | 'unavailable'

export interface MarketHeatmapToken {
  address: string
  symbol: string
  name: string
  priceUsd: number | null
  volumeUsd: number
  priceChangePct: number | null
  marketCapUsd: number | null
  liquidityUsd: number | null
}

export interface MarketHeatmapError {
  code: string
  retryable: boolean
  message: string
}

export interface MarketHeatmapResponse {
  chain: 'solana'
  interval: MarketHeatmapInterval
  limit: 20
  source: 'jupiter'
  status: MarketHeatmapStatus
  tokens: MarketHeatmapToken[]
  fetchedAt: string | null
  nextRefreshAt: string | null
  stale: boolean
  partial: boolean
  error?: MarketHeatmapError
}
