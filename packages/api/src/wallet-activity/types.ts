export type WalletLabel = 'kol' | 'smart_trader'

export type SeedToken = {
  address: string
  symbol: string
  name: string
}

export type SeedTokenSnapshot = {
  tokens: SeedToken[]
  fetchedAt: string | null
  stale: boolean
}

export type WalletActivity = {
  id: string
  walletAddress: string
  walletLabels: WalletLabel[]
  classificationToken: SeedToken
  action: 'buy' | 'sell'
  tokenAddress: string
  tokenSymbol: string
  amount: number
  priceUsd: number | null
  valueUsd: number | null
  signature: string
  observedAt: string
}

export type WalletActivityResult = {
  chain: 'solana'
  source: 'birdeye'
  status: 'ready' | 'partial' | 'stale' | 'unavailable'
  activities: WalletActivity[]
  coverage: {
    tokens: SeedToken[]
    walletCount: number
    limited: true
    lookbackDays: 30
  }
  fetchedAt: string | null
  nextRefreshAt: string | null
  stale: boolean
  partial: boolean
  error?: {
    code: string
    retryable: boolean
    message: string
  }
}

export interface WalletActivityService {
  getActivity(): Promise<WalletActivityResult>
}

export type WalletActivityRoutesOptions = {
  service: WalletActivityService
}
