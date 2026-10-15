export { PolymarketClient } from './polymarket/index.js'
export type {
  Market,
  GammaEvent,
  GammaMarket,
  MarketSnapshot,
  PolymarketClientConfig,
  PredictOperation,
  PredictOperationStatus,
  PredictOperationIdentifiers,
  PredictOperationRetry,
  PredictOperationError,
  PredictOperationEnvelope,
} from './polymarket/index.js'

export { PolymarketProfileClient } from './polymarket-profile/index.js'
export type { ProfileClientConfig, ProfileCacheConfig, PublicProfile, ProfileUser, PortfolioValue, MarketsTraded, ProfilePosition, ClosedPosition, Activity, PositionsQuery, ClosedPositionsQuery, ActivityQuery } from './polymarket-profile/index.js'

export { PacificClient } from './pacific/index.js'
export type { MarketInfo, PriceInfo, AccountInfo, Position, Order, CreateMarketOrderParams, CreateLimitOrderParams, SetTPSLParams } from './pacific/index.js'
export { PacificApiError, RateLimitError } from './pacific/index.js'

export type {
  TokenCatalogResponseV1,
  TokenIdentitySource,
  TokenIdentityV1,
  TokenResolveResponseV1,
} from './tokens/index.js'
export { isTokenResolveResponseV1 } from './tokens/index.js'

// Meteora's runtime SDK is intentionally exported from the dedicated
// `@myboon/shared/meteora` subpath so unrelated clients do not bundle it.
export type {
  MeteoraClientConfig,
  MeteoraPoolSummary,
  MeteoraPoolDetail,
  MeteoraPortfolio,
  MeteoraPosition,
  MeteoraTransactionBundle,
} from './meteora/index.js'
