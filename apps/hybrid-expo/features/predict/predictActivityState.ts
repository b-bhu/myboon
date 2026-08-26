import type { ClosedPortfolioPosition, OpenOrder, PortfolioPosition } from '@/features/predict/predict.api';
import { formatPredictTitle } from '@/features/predict/formatPredictTitle';
import { portfolioPositionCost } from '@/features/predict/formatPredictMoney';
import { getPositionSellQuote, type PositionSellQuoteMap } from '@/features/predict/positionSellQuotes';

export type PredictActivityStatus =
  | 'syncing'
  | 'waiting_to_match'
  | 'cancel_requested'
  | 'active'
  | 'ready_to_collect'
  | 'collecting'
  | 'closed_won'
  | 'closed_lost'
  | 'failed';

export type PredictActivityScope = 'market' | 'all';
export type PredictActivitySource = 'pending' | 'order' | 'position' | 'redeemable' | 'closed';

export interface PredictActivityItem {
  id: string;
  status: PredictActivityStatus;
  marketSlug: string | null;
  eventSlug: string | null;
  marketTitle: string;
  outcome: string;
  tokenId: string | null;
  conditionId: string | null;
  orderId?: string;
  putIn: number;
  currentValue: number | null;
  pnl: number | null;
  shares: number | null;
  avgPrice: number | null;
  currentPrice: number | null;
  quoteExecutable?: boolean;
  quoteLoading?: boolean;
  quoteError?: string | null;
  createdAt: number | null;
  source: PredictActivitySource;
  rawPosition?: PortfolioPosition;
  rawClosedPosition?: ClosedPortfolioPosition;
  rawOrder?: OpenOrder;
}

export interface PredictActivityMarketFilter {
  slug: string;
  eventSlug?: string | null;
  tokenIds?: readonly string[];
  conditionIds?: readonly string[];
}

export interface PredictDataFreshness {
  lastUpdatedAt: number | null;
  loading: boolean;
  stale: boolean;
  error: string | null;
  syncing?: boolean;
}

export interface PredictOrderGuardrail {
  blocking: boolean;
  title: string;
  message: string;
}

export interface BuildPredictActivityItemsInput {
  positions: PortfolioPosition[];
  redeemablePositions: PortfolioPosition[];
  openOrders: OpenOrder[];
  closedPositions: ClosedPortfolioPosition[];
  sellQuotes?: PositionSellQuoteMap;
}

function normalizeTs(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return value < 10_000_000_000 ? value * 1000 : value;
}

function normalizeDate(value: string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function formatOutcome(label: string | null | undefined): string {
  if (!label) return 'Yes';
  return label.toLowerCase().includes('draw') ? 'Draw' : label;
}

function marketTitleFromPosition(position: PortfolioPosition | ClosedPortfolioPosition): string {
  return formatPredictTitle({
    title: position.title,
    slug: position.slug || position.eventSlug,
    outcomes: 'oppositeOutcome' in position ? [position.outcome, position.oppositeOutcome] : [],
  });
}

function orderCost(order: OpenOrder): number {
  const size = Number.parseFloat(order.original_size) || 0;
  const price = Number.parseFloat(order.price) || 0;
  return size * price;
}

function remainingOrderShares(order: OpenOrder): number {
  const size = Number.parseFloat(order.original_size) || 0;
  const matched = Number.parseFloat(order.size_matched) || 0;
  return Math.max(size - matched, 0);
}

function orderMarketTitle(order: OpenOrder): string {
  if (!order.market) return 'Prediction market';
  return formatPredictTitle({ title: order.market, slug: order.market });
}

function closedStatus(position: ClosedPortfolioPosition): 'closed_won' | 'closed_lost' {
  const payout = Math.max((Number.isFinite(position.totalBought) ? position.totalBought : 0) + (position.realizedPnl ?? 0), 0);
  const won = payout > 0 && (position.curPrice >= 0.99 || (position.realizedPnl ?? 0) > 0);
  return won ? 'closed_won' : 'closed_lost';
}

export function buildPredictActivityItems({
  positions,
  redeemablePositions,
  openOrders,
  closedPositions,
  sellQuotes,
}: BuildPredictActivityItemsInput): PredictActivityItem[] {
  const active = positions.map((position, index): PredictActivityItem => {
    const putIn = portfolioPositionCost(position);
    const quote = getPositionSellQuote(sellQuotes, position);
    const currentValue = quote?.estimatedProceeds ?? null;
    return {
      id: `position-${position.conditionId}-${position.outcomeIndex}-${position.asset}-${index}`,
      status: 'active',
      marketSlug: position.slug || null,
      eventSlug: position.eventSlug || null,
      marketTitle: marketTitleFromPosition(position),
      outcome: formatOutcome(position.outcome),
      tokenId: position.asset || null,
      conditionId: position.conditionId || null,
      putIn,
      currentValue,
      pnl: quote?.cashPnl ?? null,
      shares: position.size,
      avgPrice: position.avgPrice,
      currentPrice: quote?.averagePrice ?? quote?.bestBid ?? null,
      quoteExecutable: quote?.executable ?? false,
      quoteLoading: quote?.loading ?? false,
      quoteError: quote?.error ?? null,
      createdAt: null,
      source: 'position',
      rawPosition: position,
    };
  });

  const ready = redeemablePositions.map((position, index): PredictActivityItem => {
    const putIn = portfolioPositionCost(position);
    const currentValue = position.currentValue ?? null;
    return {
      id: `redeemable-${position.conditionId}-${position.outcomeIndex}-${position.asset}-${index}`,
      status: 'ready_to_collect',
      marketSlug: position.slug || null,
      eventSlug: position.eventSlug || null,
      marketTitle: marketTitleFromPosition(position),
      outcome: formatOutcome(position.outcome),
      tokenId: position.asset || null,
      conditionId: position.conditionId || null,
      putIn,
      currentValue,
      pnl: currentValue === null ? null : currentValue - putIn,
      shares: position.size,
      avgPrice: position.avgPrice,
      currentPrice: position.curPrice,
      createdAt: normalizeDate(position.endDate),
      source: 'redeemable',
      rawPosition: position,
    };
  });

  const orders = openOrders.map((order): PredictActivityItem => {
    const price = Number.parseFloat(order.price) || 0;
    const putIn = orderCost(order);
    const pending = order.status === 'local-pending' || order.id.startsWith('pending-');
    const cancelRequested = order.status === 'cancel_requested';
    const pendingValue = pending ? putIn : null;
    return {
      id: `${pending ? 'pending' : 'order'}-${order.id}`,
      status: pending ? 'syncing' : cancelRequested ? 'cancel_requested' : 'waiting_to_match',
      marketSlug: order.market || null,
      eventSlug: null,
      marketTitle: orderMarketTitle(order),
      outcome: formatOutcome(order.outcome),
      tokenId: order.asset_id || null,
      conditionId: null,
      orderId: order.id,
      putIn,
      currentValue: pendingValue,
      pnl: pendingValue === null ? null : pendingValue - putIn,
      shares: remainingOrderShares(order),
      avgPrice: price || null,
      currentPrice: price || null,
      createdAt: normalizeTs(order.created_at),
      source: pending ? 'pending' : 'order',
      rawOrder: order,
    };
  });

  const closed = closedPositions.map((position, index): PredictActivityItem => {
    const putIn = Number.isFinite(position.totalBought) ? position.totalBought : 0;
    const pnl = Number.isFinite(position.realizedPnl) ? position.realizedPnl : 0;
    return {
      id: `closed-${position.conditionId}-${position.outcomeIndex}-${position.timestamp}-${index}`,
      status: closedStatus(position),
      marketSlug: position.slug || null,
      eventSlug: position.eventSlug || null,
      marketTitle: marketTitleFromPosition(position),
      outcome: formatOutcome(position.outcome),
      tokenId: position.asset || null,
      conditionId: position.conditionId || null,
      putIn,
      currentValue: Math.max(putIn + pnl, 0),
      pnl,
      shares: null,
      avgPrice: position.avgPrice,
      currentPrice: position.curPrice,
      createdAt: normalizeTs(position.timestamp) ?? normalizeDate(position.endDate),
      source: 'closed',
      rawClosedPosition: position,
    };
  });

  return sortPredictActivityItems([...orders, ...active, ...ready, ...closed]);
}

export function filterActivityByScope(
  items: PredictActivityItem[],
  scope: PredictActivityScope,
  market: PredictActivityMarketFilter,
): PredictActivityItem[] {
  if (scope === 'all') return items;
  const slug = market.slug.toLowerCase();
  const eventSlug = market.eventSlug?.toLowerCase() ?? null;
  const tokenIds = new Set((market.tokenIds ?? []).map((id) => id.toLowerCase()));
  const conditionIds = new Set((market.conditionIds ?? []).map((id) => id.toLowerCase()));

  return items.filter((item) => {
    const itemSlug = item.marketSlug?.toLowerCase() ?? null;
    const itemEventSlug = item.eventSlug?.toLowerCase() ?? null;
    const tokenId = item.tokenId?.toLowerCase() ?? null;
    const conditionId = item.conditionId?.toLowerCase() ?? null;
    return itemSlug === slug
      || itemEventSlug === slug
      || (!!eventSlug && (itemSlug === eventSlug || itemEventSlug === eventSlug))
      || (!!tokenId && tokenIds.has(tokenId))
      || (!!conditionId && conditionIds.has(conditionId));
  });
}

export function sortPredictActivityItems(items: PredictActivityItem[]): PredictActivityItem[] {
  const openRank: Partial<Record<PredictActivityStatus, number>> = {
    syncing: 0,
    waiting_to_match: 1,
    cancel_requested: 2,
    active: 3,
    collecting: 4,
  };
  const fallbackRank: Record<PredictActivityStatus, number> = {
    ready_to_collect: 0,
    closed_won: 1,
    closed_lost: 2,
    failed: 3,
    syncing: 4,
    waiting_to_match: 5,
    cancel_requested: 6,
    active: 7,
    collecting: 8,
  };
  return [...items].sort((a, b) => {
    const aOpenRank = openRank[a.status];
    const bOpenRank = openRank[b.status];
    const aOpen = aOpenRank !== undefined;
    const bOpen = bOpenRank !== undefined;

    if (aOpen !== bOpen) return aOpen ? -1 : 1;
    if (aOpen && bOpen && aOpenRank !== bOpenRank) return aOpenRank - bOpenRank;

    const dateDelta = (b.createdAt ?? 0) - (a.createdAt ?? 0);
    if (dateDelta !== 0) return dateDelta;

    return fallbackRank[a.status] - fallbackRank[b.status];
  });
}

export function getPredictActivityStatusLabel(status: PredictActivityStatus): string {
  switch (status) {
    case 'syncing':
      return 'Syncing with market';
    case 'waiting_to_match':
      return 'Waiting to match';
    case 'cancel_requested':
      return 'Cancel requested';
    case 'active':
      return 'Active';
    case 'ready_to_collect':
      return 'Ready to collect';
    case 'collecting':
      return 'Collecting';
    case 'closed_won':
      return 'Settled win';
    case 'closed_lost':
      return 'Settled loss';
    case 'failed':
      return 'Needs attention';
  }
}

export function formatPredictFreshness(freshness: PredictDataFreshness): string {
  if (freshness.syncing) return 'Syncing with market';
  if (freshness.loading && freshness.lastUpdatedAt === null) return 'Loading activity';
  if (freshness.error) return freshness.lastUpdatedAt === null ? 'Could not refresh' : 'Could not refresh';
  if (freshness.lastUpdatedAt === null) return 'Not updated yet';
  const seconds = Math.max(0, Math.round((Date.now() - freshness.lastUpdatedAt) / 1000));
  if (seconds < 5) return 'Updated just now';
  if (seconds < 60) return `Updated ${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return `Updated ${minutes}m ago`;
}

export function getPredictOrderGuardrail(params: {
  amount: number;
  availableCash: number | null;
  selectedPrice: number | null;
  latestPrice: number | null;
  marketActive: boolean | null;
  submitting: boolean;
  walletReady?: boolean;
}): PredictOrderGuardrail | null {
  if (params.submitting) {
    return { blocking: true, title: 'Order in progress', message: 'Placing your pick now.' };
  }
  if (params.marketActive === false) {
    return { blocking: true, title: 'Market closed', message: 'This market is no longer accepting new picks.' };
  }
  if (params.walletReady === false) {
    return { blocking: true, title: 'Wallet session needed', message: 'Reconnect your Predict wallet to place a pick.' };
  }
  if (!Number.isFinite(params.amount) || params.amount <= 0) {
    return { blocking: true, title: 'Enter an amount', message: 'Choose how much cash to put in.' };
  }
  if (params.availableCash !== null && params.amount > params.availableCash + 0.000001) {
    return { blocking: true, title: 'Not enough cash', message: `Cash available ${formatUsd(params.availableCash)}.` };
  }
  if (!params.latestPrice || !Number.isFinite(params.latestPrice) || params.latestPrice <= 0 || params.latestPrice >= 1) {
    return { blocking: true, title: 'Price unavailable', message: 'Refresh the market price before placing this pick.' };
  }
  if (
    params.selectedPrice !== null
    && params.latestPrice !== null
    && Math.abs(params.selectedPrice - params.latestPrice) >= 0.01
  ) {
    return {
      blocking: false,
      title: 'Price moved',
      message: `Price moved from ${formatPercent(params.selectedPrice)} to ${formatPercent(params.latestPrice)}.`,
    };
  }
  return null;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}
