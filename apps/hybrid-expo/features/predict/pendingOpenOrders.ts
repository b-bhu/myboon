import type { OpenOrder, PortfolioPosition, RecentAccountTrade } from '@/features/predict/predict.api';
import type { PredictActivityItem } from '@/features/predict/predictActivityState';

interface PendingOpenOrderParams {
  id?: string;
  slug: string;
  tokenID: string;
  outcome: string;
  price: number;
  size: number;
}

export function makePendingOpenOrder(params: PendingOpenOrderParams): OpenOrder {
  return {
    id: params.id ?? `pending-${params.tokenID}-${Date.now()}`,
    status: 'local-pending',
    market: params.slug,
    asset_id: params.tokenID,
    side: 'BUY',
    original_size: String(params.size),
    size_matched: '0',
    price: String(params.price),
    outcome: params.outcome,
    created_at: Date.now(),
    order_type: 'GTC',
  };
}

export function prunePendingOpenOrders(
  pending: OpenOrder[],
  fetchedOrders: OpenOrder[],
  positions: PortfolioPosition[],
  recentTrades: RecentAccountTrade[] = [],
): OpenOrder[] {
  const pendingIds = new Set(pending.map((order) => order.id).filter(Boolean));
  const fetchedOrderIds = new Set(fetchedOrders.map((order) => order.id).filter(Boolean));
  const tradedOrderIds = new Set(recentTrades.flatMap((trade) => [trade.takerOrderId, ...trade.makerOrderIds]));
  const remoteAssetCounts = new Map<string, number>();

  for (const order of fetchedOrders) {
    if (pendingIds.has(order.id)) continue;
    const assetId = order.asset_id?.toLowerCase();
    if (assetId) remoteAssetCounts.set(assetId, (remoteAssetCounts.get(assetId) ?? 0) + 1);
  }
  for (const position of positions) {
    const assetId = position.asset?.toLowerCase();
    if (assetId) remoteAssetCounts.set(assetId, (remoteAssetCounts.get(assetId) ?? 0) + 1);
  }

  return pending.filter((order) => {
    const assetId = order.asset_id?.toLowerCase();
    if (!assetId) return false;
    if (fetchedOrderIds.has(order.id)) return false;
    if (tradedOrderIds.has(order.id)) return false;

    const remoteCount = remoteAssetCounts.get(assetId) ?? 0;
    if (remoteCount > 0) {
      remoteAssetCounts.set(assetId, remoteCount - 1);
      return false;
    }

    return true;
  });
}

export function mergeOpenOrders(pending: OpenOrder[], fetched: OpenOrder[]): OpenOrder[] {
  const pendingIds = new Set(pending.map((order) => order.id).filter(Boolean));
  const fetchedIds = new Set(fetched.map((order) => order.id));
  const fetchedAssetCounts = new Map<string, number>();
  for (const order of fetched) {
    if (pendingIds.has(order.id)) continue;
    const assetId = order.asset_id?.toLowerCase();
    if (assetId) fetchedAssetCounts.set(assetId, (fetchedAssetCounts.get(assetId) ?? 0) + 1);
  }

  const visiblePending = pending.filter((order) => {
    if (fetchedIds.has(order.id)) return false;
    const assetId = order.asset_id?.toLowerCase();
    const remoteCount = assetId ? fetchedAssetCounts.get(assetId) ?? 0 : 0;
    if (assetId && remoteCount > 0) {
      fetchedAssetCounts.set(assetId, remoteCount - 1);
      return false;
    }
    return true;
  });

  return [...visiblePending, ...fetched];
}

export interface PendingPredictAction {
  id: string;
  type: 'buy' | 'sell' | 'cancel' | 'redeem';
  tokenId: string | null;
  orderId?: string;
  marketSlug: string;
  outcome: string;
  amount: number;
  shares: number | null;
  createdAt: number;
}

export function reconcilePendingActions(
  pending: PendingPredictAction[],
  remoteItems: PredictActivityItem[],
): PendingPredictAction[] {
  const pendingOrderIds = new Set(pending.map((action) => action.orderId).filter(Boolean));
  const remoteOrderIds = new Set(remoteItems.map((item) => item.orderId).filter(Boolean));
  const remoteTokenCounts = new Map<string, number>();
  for (const item of remoteItems) {
    if (item.orderId && pendingOrderIds.has(item.orderId)) continue;
    if (item.tokenId) remoteTokenCounts.set(item.tokenId, (remoteTokenCounts.get(item.tokenId) ?? 0) + 1);
  }

  return pending.filter((action) => {
    if (action.orderId && remoteOrderIds.has(action.orderId)) return false;
    if (action.tokenId !== null) {
      const remoteCount = remoteTokenCounts.get(action.tokenId) ?? 0;
      if (remoteCount > 0) {
        remoteTokenCounts.set(action.tokenId, remoteCount - 1);
        return false;
      }
    }
    return true;
  });
}
