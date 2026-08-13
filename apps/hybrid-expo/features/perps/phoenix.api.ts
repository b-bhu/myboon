import { fetchWithTimeout, resolveApiBaseUrl } from '@/lib/api';
import type { PerpsCandleInterval } from '@/features/perps/perps.contract';

export type PhoenixMarketStatus = 'active' | 'post_only' | 'paused' | 'closed' | 'tombstoned' | 'unknown' | string;

export interface PhoenixLeverageTier {
  maxLeverage: number | null;
  notionalCapUsd?: number | null;
}

export interface PhoenixMarket {
  venueId: 'phoenix';
  symbol: string;
  venueSymbol: string;
  baseSymbol: string;
  displayName: string;
  quoteSymbol: 'USDC' | 'USD';
  /** API-relative cached icon path, same shape as Pacifica's. Null until resolved. */
  iconPath: string | null;
  status: PhoenixMarketStatus;
  tradeable: boolean;
  maxLeverage: number | null;
  tickSize: string | null;
  lotSize: string | null;
  minOrderSize: string | null;
  markPrice: number | null;
  oraclePrice: number | null;
  midPrice: number | null;
  fundingRate: number | null;
  openInterest: number | null;
  volume24h: number | null;
  change24h: number | null;
  dataFreshness: 'live' | 'snapshot' | 'stale' | 'partial' | 'unavailable';
  dataFreshnessReason: string | null;
  configFetchedAt: string | null;
  precision: {
    tickSize: string | null;
    rawTickSize: number | string | null;
    baseLotsDecimals: number | null;
  };
  limits: {
    openInterestCapBaseLots: string | null;
    maxLiquidationSizeBaseLots: string | null;
    leverageTiers: PhoenixLeverageTier[];
  };
  fees: {
    makerFee: number | null;
    takerFee: number | null;
  };
  funding: {
    fundingIntervalSeconds: number | null;
    fundingPeriodSeconds: number | null;
    maxFundingRatePerInterval: string | null;
    maxFundingRatePerIntervalPercentage: number | null;
  };
  metadata: {
    assetId: number | null;
    marketPubkey: string | null;
    splinePubkey: string | null;
    isolatedOnly: boolean | null;
  };
}

export interface PhoenixCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  volumeQuote: number | null;
  tradeCount: number | null;
  externalSource: string | null;
}

export type PhoenixCandleInterval = Extract<PerpsCandleInterval, '1s' | '5s' | '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d'>;

export interface PhoenixTraderState {
  venueId: 'phoenix';
  action: 'get_trader_state';
  authority: string;
  pdaIndex: number;
  slot: number | null;
  slotIndex: number | null;
  traders: unknown[];
  raw: unknown;
}

export interface PhoenixActivationResult {
  venueId: 'phoenix';
  action: 'activate_invite' | 'activate_referral';
  authority: string | null;
  traderPda: string | null;
  raw: unknown;
}

export interface PhoenixPaginatedResponse<T = unknown> {
  venueId?: 'phoenix';
  action?: string;
  authority?: string;
  data: T[];
  hasMore: boolean;
  nextCursor: string | null;
  prevCursor: string | null;
  raw?: unknown;
}

export type PhoenixOrderHistoryItem = Record<string, unknown>;
export type PhoenixTradeHistoryItem = Record<string, unknown>;
export type PhoenixCollateralHistoryItem = Record<string, unknown>;

export interface PhoenixHistoryQuery {
  pdaIndex?: number;
  traderPdaIndex?: number;
  marketSymbol?: string;
  symbol?: string;
  limit?: number;
  cursor?: string;
}

export interface PhoenixInstructionAccountMetaDto {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}

export type PhoenixInstructionDataDto =
  | number[]
  | string
  | Uint8Array
  | {
      data?: number[] | string;
      bytes?: number[] | string;
      base64?: string;
      hex?: string;
    };

export interface PhoenixInstructionDto {
  programId?: string;
  program_id?: string;
  keys?: PhoenixInstructionAccountMetaDto[];
  accounts?: PhoenixInstructionAccountMetaDto[];
  data: PhoenixInstructionDataDto;
}

export interface PhoenixInstructionBuilderResult {
  venueId: 'phoenix';
  action: string;
  mode: 'solana_instruction_builder';
  endpoint: string;
  instructions: PhoenixInstructionDto[];
  estimatedLiquidationPriceUsd?: number | null;
  raw: unknown;
}

export type PhoenixUiOrderSide = 'long' | 'short' | 'bid' | 'ask' | 'Side.Bid' | 'Side.Ask' | string;

export interface PhoenixBaseOrderBuilderInput extends Record<string, unknown> {
  authority: string;
  symbol: string;
  side: PhoenixUiOrderSide;
  feePayer?: string;
  positionAuthority?: string;
  pdaIndex?: number;
  transferAmount?: string | number;
  quantity?: string | number;
  numBaseLots?: string | number;
  tpSl?: unknown;
  isReduceOnly?: boolean;
}

export interface PhoenixMarketOrderBuilderInput extends PhoenixBaseOrderBuilderInput {
  maxPriceInTicks?: string | number;
}

export interface PhoenixLimitOrderBuilderInput extends PhoenixBaseOrderBuilderInput {
  price?: string | number;
  priceInTicks?: string | number;
  isPostOnly?: boolean;
  slide?: boolean;
}

export interface PhoenixCancelConditionalOrderBuilderInput extends Record<string, unknown> {
  authority: string;
  symbol: string;
  executionDirection: string;
  traderPdaIndex: number;
  conditionalOrderIndex: number;
}

export interface PhoenixPositionConditionalOrderBuilderInput extends Record<string, unknown> {
  authority: string;
  symbol: string;
  positionSide: 'long' | 'short' | string;
  takeProfitPrice?: string | number;
  stopLossPrice?: string | number;
  positionAuthority?: string;
  pdaIndex?: number;
  traderPdaIndex?: number;
  traderSubaccountIndex?: number;
  baseUnits?: string | number;
  sizeBaseLots?: string | number;
  sizePercent?: number;
}

export interface PhoenixInviteActivationInput extends Record<string, unknown> {
  authority: string;
  code: string;
}

export interface PhoenixReferralActivationInput extends Record<string, unknown> {
  authority: string;
  referral_code: string;
}

export interface PhoenixTransferBuilderInput extends Record<string, unknown> {
  authority: string;
  amount?: string | number;
  amountUsdc?: string | number;
  amountAtomic?: string | number;
  feePayer?: string;
  pdaIndex?: number;
  traderPdaIndex?: number;
  traderSubaccountIndex?: number;
  permissionAddress?: string;
}

export class PhoenixUnsupportedBuilderError extends Error {
  readonly code = 'PHOENIX_BUILDER_UNSUPPORTED';
  readonly operation: string;

  constructor(operation: string) {
    super(`Phoenix ${operation} transaction builders are not supported by the public API.`);
    this.name = 'PhoenixUnsupportedBuilderError';
    this.operation = operation;
  }
}

export const PHOENIX_API_PATH = '/perps/phoenix';

function asRecord(input: unknown): Record<string, unknown> | null {
  return input !== null && typeof input === 'object' ? input as Record<string, unknown> : null;
}

function asString(input: unknown): string | null {
  return typeof input === 'string' && input.trim().length > 0 ? input : null;
}

function asBoolean(input: unknown): boolean | null {
  return typeof input === 'boolean' ? input : null;
}

function asNumber(input: unknown): number | null {
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  if (typeof input !== 'string') return null;
  const parsed = Number.parseFloat(input);
  return Number.isFinite(parsed) ? parsed : null;
}

function asInt(input: unknown): number | null {
  const value = asNumber(input);
  return value === null ? null : Math.trunc(value);
}

function stringify(input: unknown): string | null {
  if (typeof input === 'string') return input;
  if (typeof input === 'number' && Number.isFinite(input)) return String(input);
  return null;
}

function normalizeVenueSymbol(input: string): string {
  return input.trim().toUpperCase().replace(/-PERP$/, '');
}

function appSymbolFromVenueSymbol(venueSymbol: string): string {
  return `${venueSymbol}-PERP`;
}

function payloadArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const record = asRecord(payload);
  return Array.isArray(record?.data) ? record.data : [];
}

function normalizePaginatedResponse<T = unknown>(payload: unknown): PhoenixPaginatedResponse<T> {
  const record = asRecord(payload) ?? {};
  return {
    venueId: asString(record.venueId) === 'phoenix' ? 'phoenix' : undefined,
    action: asString(record.action) ?? undefined,
    authority: asString(record.authority) ?? undefined,
    data: payloadArray(payload) as T[],
    hasMore: asBoolean(record.hasMore) ?? false,
    nextCursor: asString(record.nextCursor),
    prevCursor: asString(record.prevCursor),
    raw: 'raw' in record ? record.raw : payload,
  };
}

function historyParams(query: PhoenixHistoryQuery = {}, useTraderPdaIndex = false): URLSearchParams {
  const params = new URLSearchParams();
  const index = useTraderPdaIndex ? query.traderPdaIndex ?? query.pdaIndex : query.pdaIndex;
  if (typeof index === 'number' && Number.isFinite(index)) {
    params.set(useTraderPdaIndex ? 'traderPdaIndex' : 'pdaIndex', String(Math.trunc(index)));
  }
  if (query.marketSymbol ?? query.symbol) params.set('marketSymbol', query.marketSymbol ?? query.symbol ?? '');
  if (typeof query.limit === 'number' && Number.isFinite(query.limit)) params.set('limit', String(Math.trunc(query.limit)));
  if (query.cursor) params.set('cursor', query.cursor);
  return params;
}

function normalizeLeverageTiers(input: unknown): PhoenixLeverageTier[] {
  if (!Array.isArray(input)) return [];
  return input.map((item) => {
    const record = asRecord(item) ?? {};
    return {
      maxLeverage: asNumber(record.maxLeverage),
      notionalCapUsd: asNumber(record.notionalCapUsd),
    };
  });
}

function normalizeMarket(input: unknown): PhoenixMarket | null {
  const record = asRecord(input);
  if (!record) return null;

  const venueSymbol = normalizeVenueSymbol(
    asString(record.venueSymbol) ?? asString(record.baseSymbol) ?? asString(record.symbol) ?? '',
  );
  if (!venueSymbol) return null;

  const symbol = asString(record.symbol) ?? appSymbolFromVenueSymbol(venueSymbol);
  const status = asString(record.status) ?? asString(record.marketStatus) ?? 'unknown';
  const precision = asRecord(record.precision) ?? {};
  const limits = asRecord(record.limits) ?? {};
  const fees = asRecord(record.fees) ?? {};
  const funding = asRecord(record.funding) ?? {};
  const metadata = asRecord(record.metadata) ?? {};

  return {
    venueId: 'phoenix',
    symbol,
    venueSymbol,
    baseSymbol: asString(record.baseSymbol) ?? venueSymbol,
    displayName: `${venueSymbol} Perpetual`,
    quoteSymbol: (asString(record.quoteSymbol) === 'USD' ? 'USD' : 'USDC'),
    iconPath: asString(record.iconPath),
    status,
    tradeable: asBoolean(record.tradeable) ?? status === 'active',
    maxLeverage: asNumber(record.maxLeverage),
    tickSize: stringify(record.tickSize),
    lotSize: stringify(record.lotSize),
    minOrderSize: stringify(record.minOrderSize),
    markPrice: asNumber(record.markPrice),
    oraclePrice: asNumber(record.oraclePrice),
    midPrice: asNumber(record.midPrice),
    fundingRate: asNumber(record.fundingRate),
    openInterest: asNumber(record.openInterest),
    volume24h: asNumber(record.volume24h),
    change24h: asNumber(record.change24h),
    dataFreshness: (asString(record.dataFreshness) as PhoenixMarket['dataFreshness'] | null) ?? 'partial',
    dataFreshnessReason: asString(record.dataFreshnessReason),
    configFetchedAt: asString(record.configFetchedAt),
    precision: {
      tickSize: stringify(precision.tickSize),
      rawTickSize: stringify(precision.rawTickSize) ?? asNumber(precision.rawTickSize),
      baseLotsDecimals: asInt(precision.baseLotsDecimals),
    },
    limits: {
      openInterestCapBaseLots: stringify(limits.openInterestCapBaseLots),
      maxLiquidationSizeBaseLots: stringify(limits.maxLiquidationSizeBaseLots),
      leverageTiers: normalizeLeverageTiers(limits.leverageTiers),
    },
    fees: {
      makerFee: asNumber(fees.makerFee),
      takerFee: asNumber(fees.takerFee),
    },
    funding: {
      fundingIntervalSeconds: asInt(funding.fundingIntervalSeconds),
      fundingPeriodSeconds: asInt(funding.fundingPeriodSeconds),
      maxFundingRatePerInterval: stringify(funding.maxFundingRatePerInterval),
      maxFundingRatePerIntervalPercentage: asNumber(funding.maxFundingRatePerIntervalPercentage),
    },
    metadata: {
      assetId: asInt(metadata.assetId),
      marketPubkey: asString(metadata.marketPubkey),
      splinePubkey: asString(metadata.splinePubkey),
      isolatedOnly: asBoolean(metadata.isolatedOnly),
    },
  };
}

function normalizeCandle(input: unknown): PhoenixCandle | null {
  const record = asRecord(input);
  if (!record) return null;

  const time = asInt(record.time);
  const open = asNumber(record.open);
  const high = asNumber(record.high);
  const low = asNumber(record.low);
  const close = asNumber(record.close);

  if (time === null || open === null || high === null || low === null || close === null) {
    return null;
  }

  return {
    time,
    open,
    high,
    low,
    close,
    volume: asNumber(record.volume) ?? 0,
    volumeQuote: asNumber(record.volumeQuote),
    tradeCount: asInt(record.tradeCount),
    externalSource: asString(record.externalSource),
  };
}

function parseJsonText(text: string): unknown {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function errorMessage(payload: unknown, status: number): string {
  const record = asRecord(payload);
  return asString(record?.error)
    ?? asString(record?.message)
    ?? `Phoenix unavailable (${status})`;
}

async function phoenixRequest(path: string, init?: RequestInit): Promise<unknown> {
  const headers = {
    Accept: 'application/json',
    ...(init?.headers as Record<string, string> | undefined),
  };
  const res = await fetchWithTimeout(`${resolveApiBaseUrl()}${PHOENIX_API_PATH}${path}`, {
    ...init,
    headers: {
      ...headers,
    },
  });
  const text = await res.text();
  const payload = parseJsonText(text);

  if (!res.ok) {
    throw new Error(errorMessage(payload, res.status));
  }

  return payload;
}

async function phoenixGet(path: string): Promise<unknown> {
  return phoenixRequest(path);
}

async function phoenixPost(path: string, body: Record<string, unknown>): Promise<unknown> {
  return phoenixRequest(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function fetchPhoenixMarkets(): Promise<PhoenixMarket[]> {
  const payload = await phoenixGet('/markets');
  return payloadArray(payload)
    .map(normalizeMarket)
    .filter((market): market is PhoenixMarket => market !== null);
}

export async function fetchPhoenixMarket(symbol: string): Promise<PhoenixMarket> {
  const normalized = normalizeVenueSymbol(symbol);
  const markets = await fetchPhoenixMarkets();
  const market = markets.find((item) => (
    item.venueSymbol === normalized
    || item.baseSymbol === normalized
    || item.symbol === appSymbolFromVenueSymbol(normalized)
  ));

  if (!market) throw new Error(`Phoenix market ${symbol} not found`);
  return market;
}

export async function fetchPhoenixCandles(
  symbol: string,
  interval: PhoenixCandleInterval,
  count: number,
): Promise<PhoenixCandle[]> {
  const params = new URLSearchParams({
    symbol: normalizeVenueSymbol(symbol),
    interval,
    count: String(count),
    enableExternalSource: 'true',
  });

  const payload = await phoenixGet(`/candles?${params.toString()}`);
  return payloadArray(payload)
    .map(normalizeCandle)
    .filter((candle): candle is PhoenixCandle => candle !== null)
    .sort((a, b) => a.time - b.time);
}

export function phoenixSideFromUiSide(side: PhoenixUiOrderSide): string {
  const normalized = String(side).trim().toLowerCase();
  if (normalized === 'long' || normalized === 'bid' || normalized === 'side.bid') return 'bid';
  if (normalized === 'short' || normalized === 'ask' || normalized === 'side.ask') return 'ask';
  return String(side);
}

function normalizePhoenixBuilderSide<T extends { side?: PhoenixUiOrderSide }>(input: T): T {
  if (!input.side) return input;
  return { ...input, side: phoenixSideFromUiSide(input.side) };
}

function normalizeInstructionBuilderResult(
  payload: unknown,
  fallbackAction: string,
  fallbackEndpoint: string,
): PhoenixInstructionBuilderResult {
  const record = asRecord(payload);
  const instructions = Array.isArray(payload)
    ? payload
    : (Array.isArray(record?.instructions) ? record.instructions : []);

  return {
    venueId: 'phoenix',
    action: asString(record?.action) ?? fallbackAction,
    mode: 'solana_instruction_builder',
    endpoint: asString(record?.endpoint) ?? fallbackEndpoint,
    instructions: instructions as PhoenixInstructionDto[],
    estimatedLiquidationPriceUsd: asNumber(record?.estimatedLiquidationPriceUsd),
    raw: record && 'raw' in record ? record.raw : payload,
  };
}

export async function fetchPhoenixTraderState(authority: string, pdaIndex = 0): Promise<PhoenixTraderState> {
  const params = new URLSearchParams({ pdaIndex: String(pdaIndex) });
  const payload = await phoenixGet(`/trader/${encodeURIComponent(authority)}/state?${params.toString()}`);
  return payload as PhoenixTraderState;
}

export async function fetchPhoenixOrderHistory(
  authority: string,
  query: PhoenixHistoryQuery = {},
): Promise<PhoenixPaginatedResponse<PhoenixOrderHistoryItem>> {
  const params = historyParams({ limit: 50, ...query }, true);
  const payload = await phoenixGet(`/trader/${encodeURIComponent(authority)}/order-history?${params.toString()}`);
  return normalizePaginatedResponse<PhoenixOrderHistoryItem>(payload);
}

export async function fetchPhoenixTradeHistory(
  authority: string,
  query: PhoenixHistoryQuery = {},
): Promise<PhoenixPaginatedResponse<PhoenixTradeHistoryItem>> {
  const params = historyParams({ limit: 50, ...query });
  const payload = await phoenixGet(`/trader/${encodeURIComponent(authority)}/trades-history?${params.toString()}`);
  return normalizePaginatedResponse<PhoenixTradeHistoryItem>(payload);
}

export async function fetchPhoenixCollateralHistory(
  authority: string,
  query: PhoenixHistoryQuery = {},
): Promise<PhoenixPaginatedResponse<PhoenixCollateralHistoryItem>> {
  const params = historyParams({ limit: 50, ...query });
  const payload = await phoenixGet(`/trader/${encodeURIComponent(authority)}/collateral-history?${params.toString()}`);
  return normalizePaginatedResponse<PhoenixCollateralHistoryItem>(payload);
}

export async function activatePhoenixInvite(input: PhoenixInviteActivationInput): Promise<PhoenixActivationResult> {
  const payload = await phoenixPost('/invite/activate', input);
  return payload as PhoenixActivationResult;
}

export async function activatePhoenixReferral(input: PhoenixReferralActivationInput): Promise<PhoenixActivationResult> {
  const payload = await phoenixPost('/invite/activate-with-referral', input);
  return payload as PhoenixActivationResult;
}

export async function buildPhoenixMarketOrder(
  input: PhoenixMarketOrderBuilderInput,
): Promise<PhoenixInstructionBuilderResult> {
  const payload = await phoenixPost('/tx/market-order', normalizePhoenixBuilderSide(input));
  return normalizeInstructionBuilderResult(payload, 'place_isolated_market_order', '/tx/market-order');
}

export async function buildPhoenixLimitOrder(
  input: PhoenixLimitOrderBuilderInput,
): Promise<PhoenixInstructionBuilderResult> {
  const payload = await phoenixPost('/tx/limit-order', normalizePhoenixBuilderSide(input));
  return normalizeInstructionBuilderResult(payload, 'place_isolated_limit_order', '/tx/limit-order');
}

export async function buildPhoenixOrder(
  input: (PhoenixMarketOrderBuilderInput & { orderType: 'market' })
    | (PhoenixLimitOrderBuilderInput & { orderType: 'limit' }),
): Promise<PhoenixInstructionBuilderResult> {
  const { orderType, ...rest } = input;
  return orderType === 'limit'
    ? buildPhoenixLimitOrder(rest as PhoenixLimitOrderBuilderInput)
    : buildPhoenixMarketOrder(rest as PhoenixMarketOrderBuilderInput);
}

export async function buildPhoenixCancelConditionalOrder(
  input: PhoenixCancelConditionalOrderBuilderInput,
): Promise<PhoenixInstructionBuilderResult> {
  const payload = await phoenixPost('/tx/cancel-conditional-order', input);
  return normalizeInstructionBuilderResult(payload, 'cancel_conditional_order', '/tx/cancel-conditional-order');
}

export async function buildPhoenixPositionConditionalOrder(
  input: PhoenixPositionConditionalOrderBuilderInput,
): Promise<PhoenixInstructionBuilderResult> {
  const payload = await phoenixPost('/tx/position-conditional-order', input);
  return normalizeInstructionBuilderResult(payload, 'place_position_conditional_order', '/tx/position-conditional-order');
}

export async function buildPhoenixDeposit(input: PhoenixTransferBuilderInput): Promise<PhoenixInstructionBuilderResult> {
  const payload = await phoenixPost('/tx/deposit', input);
  return normalizeInstructionBuilderResult(payload, 'deposit', '/tx/deposit');
}

export async function buildPhoenixWithdraw(input: PhoenixTransferBuilderInput): Promise<PhoenixInstructionBuilderResult> {
  const payload = await phoenixPost('/tx/withdraw', input);
  return normalizeInstructionBuilderResult(payload, 'withdraw', '/tx/withdraw');
}

// Re-export aliases onto lib/format's consolidated formatters. Keeps every
// existing detail/profile/chart screen importing from this module compiling
// with zero edits, per the token-identity-and-venue-adapters PRD (formatter
// consolidation, acceptance criterion 6).
export {
  formatPrice as formatPhoenixPrice,
  formatPercent as formatPhoenixPercent,
  formatRate as formatPhoenixRate,
} from '@/lib/format';
