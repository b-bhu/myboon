import {
  PACIFIC_ENV,
  PACIFIC_MIN_DEPOSIT,
  PACIFIC_REST,
  PACIFIC_WS,
  USDC_LABEL,
  USDC_MINT,
} from '@/features/perps/pacific.config';
import type { PerpsCandleInterval, PerpsVenueDescriptor, PerpsVenueId } from '@/features/perps/perps.contract';
import { PERPS_VENUE_IDS } from '@/features/perps/perps.contract';

export const PACIFICA_SUPPORTED_INTERVALS = [
  '1m',
  '3m',
  '5m',
  '15m',
  '30m',
  '1h',
  '2h',
  '4h',
  '8h',
  '12h',
  '1d',
] as const satisfies readonly PerpsCandleInterval[];

export const PHOENIX_SUPPORTED_INTERVALS = [
  '1s',
  '5s',
  '1m',
  '5m',
  '15m',
  '30m',
  '1h',
  '4h',
  '1d',
] as const satisfies readonly PerpsCandleInterval[];

export const PACIFICA_VENUE_DESCRIPTOR = {
  venueId: 'pacifica',
  displayName: 'Pacifica',
  shortName: 'Pacifica',
  routeBase: '/markets/pacifica',
  apiBasePath: '/perps/pacifica',
  env: PACIFIC_ENV,
  integrationStatus: 'active',
  quoteAsset: 'USDC',
  defaultCollateralAsset: USDC_LABEL,
  publicRestBaseUrl: PACIFIC_REST,
  publicWsBaseUrl: PACIFIC_WS,
  collateralMint: USDC_MINT,
  minDepositUsdc: PACIFIC_MIN_DEPOSIT,
  supportedIntervals: PACIFICA_SUPPORTED_INTERVALS,
  defaultInterval: '15m',
  capabilities: {
    publicMarkets: true,
    candles: true,
    liveMarketData: true,
    accountRead: true,
    positionsRead: true,
    ordersRead: true,
    deposit: true,
    withdraw: true,
    marketOrder: true,
    limitOrder: true,
    cancelOrder: true,
    closePosition: true,
    takeProfitStopLoss: true,
    history: false,
    messageSigningExecution: true,
    transactionSigningExecution: true,
  },
  notes: ['Current /trade behavior remains Pacifica-first while shared perps adapters are introduced.'],
} as const satisfies PerpsVenueDescriptor;

export const PHOENIX_VENUE_DESCRIPTOR = {
  venueId: 'phoenix',
  displayName: 'Phoenix',
  shortName: 'Phoenix',
  routeBase: '/markets/phoenix',
  apiBasePath: '/perps/phoenix',
  env: 'mainnet',
  integrationStatus: 'incomplete',
  quoteAsset: 'USDC',
  defaultCollateralAsset: 'USDC',
  publicRestBaseUrl: 'https://perp-api.phoenix.trade',
  publicWsBaseUrl: 'wss://perp-api.phoenix.trade/v1/ws',
  supportedIntervals: PHOENIX_SUPPORTED_INTERVALS,
  defaultInterval: '15m',
  capabilities: {
    publicMarkets: true,
    candles: true,
    liveMarketData: false,
    accountRead: true,
    positionsRead: true,
    ordersRead: true,
    deposit: true,
    withdraw: true,
    marketOrder: true,
    limitOrder: true,
    cancelOrder: true,
    closePosition: false,
    takeProfitStopLoss: false,
    history: true,
    messageSigningExecution: false,
    transactionSigningExecution: true,
    accessCodeRequired: true,
    regionRestricted: true,
    incomplete: true,
  },
  notes: [
    'Phoenix order execution uses public REST instruction builders and Solana wallet transaction signing.',
    'Phoenix deposit and withdraw use Rise SDK Ember collateral builders through the API transaction builder.',
  ],
} as const satisfies PerpsVenueDescriptor;

export const PERPS_DEFAULT_VENUE_ID: PerpsVenueId = 'pacifica';

export const PERPS_VENUE_DESCRIPTORS = {
  pacifica: PACIFICA_VENUE_DESCRIPTOR,
  phoenix: PHOENIX_VENUE_DESCRIPTOR,
} as const satisfies Record<PerpsVenueId, PerpsVenueDescriptor>;

export function isPerpsVenueId(value: string | null | undefined): value is PerpsVenueId {
  return typeof value === 'string' && (PERPS_VENUE_IDS as readonly string[]).includes(value);
}

export function getPerpsVenueDescriptor(venueId: PerpsVenueId = PERPS_DEFAULT_VENUE_ID): PerpsVenueDescriptor {
  return PERPS_VENUE_DESCRIPTORS[venueId];
}

export function listPerpsVenueDescriptors(): readonly PerpsVenueDescriptor[] {
  return PERPS_VENUE_IDS.map((venueId) => PERPS_VENUE_DESCRIPTORS[venueId]);
}

export function getPerpsSupportedIntervals(venueId: PerpsVenueId): readonly PerpsCandleInterval[] {
  return PERPS_VENUE_DESCRIPTORS[venueId].supportedIntervals;
}
