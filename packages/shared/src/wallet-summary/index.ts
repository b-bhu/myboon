/**
 * Shared wallet-summary surface: the Polymarket, Phoenix and Pacifica value
 * logic the Expo app and the server must agree on (issue #723), plus the
 * wallet-summary API contract types and fixture (from main).
 */
export type {
  AppSummary,
  PacificaSummary,
  PhoenixSummary,
  PolymarketSummary,
  MeteoraSummary,
  SpotSummary,
  VenueStatus,
  MeteoraPositionsResponse,
  WalletMeteoraPool,
  WalletMeteoraPosition,
  WalletPerpPosition,
  WalletPerpPositionDetail,
  PerpPositionsResponse,
  WalletPhoenixOrder,
  PhoenixOrdersResponse,
  WalletSpotToken,
  WalletSummary,
} from './types.js'

export { walletSummaryFixture } from './fixtures.js'
export {
  HELD_POSITIONS_PAGE_CEILING,
  mapSdkPosition,
  mergeHeldPositions,
  summarizeHeldPositions,
  sumReadyToCollect,
  walkAllPages,
} from './polymarket-helpers.js';
// Type-only re-exports use `export type` so the barrel loads under Node ESM
// (the API runs on tsx/Node, where re-exporting an interface as a value throws).
export type { HeldPositionSummary, PortfolioPosition, SdkPosition } from './polymarket-helpers.js';
export { resolveCashOutNow } from './portfolio-totals.js';
export {
  accountSummary,
  sumPhoenixPortfolioValue,
  sumUsd,
  toNumber,
  toUsd,
} from './phoenix.js';
export type { PhoenixAccountSummary, PhoenixTraderRecord } from './phoenix.js';
export { pacificaUnrealizedPnl, safeNum } from './pacifica.js';
export { polymarketValueUsd } from './polymarket-value.js';
export type { PolymarketValueInput } from './polymarket-value.js';
