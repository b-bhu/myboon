import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchOrderbook } from '@/features/polymarket/polymarket.api';
import type { PortfolioPosition } from '@/features/polymarket/polymarket.api';
import type { Orderbook } from '@/features/polymarket/polymarket.types';
import { portfolioPositionCost } from '@/features/polymarket/formatPolymarketMoney';
import { buildExecutableSellQuote } from '@/features/polymarket/orderbookQuote';

export interface OrderbookState {
  book: Orderbook | null;
  loading: boolean;
  error: string | null;
}

export interface PositionSellQuote {
  asset: string;
  executable: boolean;
  requestedShares: number;
  filledShares: number;
  averagePrice: number | null;
  limitPrice: number | null;
  bestBid: number | null;
  estimatedProceeds: number | null;
  cashPnl: number | null;
  percentPnl: number | null;
  unfilledShares: number;
  loading: boolean;
  error: string | null;
}

export type PositionSellQuoteMap = Record<string, PositionSellQuote | undefined>;
export type PositionOrderbookMap = Record<string, OrderbookState | undefined>;

export function positionSellQuoteKey(position: PortfolioPosition): string {
  return `${position.conditionId}:${position.outcomeIndex}:${position.asset}`;
}

export function getPositionSellQuote(
  quotes: PositionSellQuoteMap | null | undefined,
  position: PortfolioPosition | null | undefined,
): PositionSellQuote | null {
  if (!quotes || !position) return null;
  return quotes[positionSellQuoteKey(position)] ?? null;
}

export function buildPositionSellQuote(
  position: PortfolioPosition,
  book: Orderbook | null,
  sharesToSell = position.size,
  loading = false,
  error: string | null = null,
): PositionSellQuote {
  if (!book) {
    return {
      asset: position.asset,
      executable: false,
      requestedShares: Math.max(sharesToSell, 0),
      filledShares: 0,
      averagePrice: null,
      limitPrice: null,
      bestBid: null,
      estimatedProceeds: null,
      cashPnl: null,
      percentPnl: null,
      unfilledShares: Math.max(sharesToSell, 0),
      loading,
      error,
    };
  }

  const quote = buildExecutableSellQuote(book, sharesToSell);
  const costRatio = position.size > 0 ? sharesToSell / position.size : 0;
  const cost = portfolioPositionCost(position) * costRatio;
  const cashPnl = quote.estimatedProceeds - cost;

  return {
    asset: position.asset,
    executable: quote.executable,
    requestedShares: quote.requestedShares,
    filledShares: quote.filledShares,
    averagePrice: quote.averagePrice,
    limitPrice: quote.limitPrice,
    bestBid: quote.bestBid,
    estimatedProceeds: quote.estimatedProceeds,
    cashPnl,
    percentPnl: cost > 0 ? (cashPnl / cost) * 100 : null,
    unfilledShares: quote.unfilledShares,
    loading,
    error,
  };
}

export function usePositionSellQuotes(positions: PortfolioPosition[]) {
  const [booksByAsset, setBooksByAsset] = useState<PositionOrderbookMap>({});
  const [refreshNonce, setRefreshNonce] = useState(0);

  const assetKey = useMemo(() => {
    const assets = Array.from(new Set(positions.map((position) => position.asset).filter(Boolean))).sort();
    return assets.join(',');
  }, [positions]);

  const refresh = useCallback(() => {
    setRefreshNonce((current) => current + 1);
  }, []);

  useEffect(() => {
    if (!assetKey) return undefined;
    const timer = globalThis.setInterval(refresh, 15_000);
    return () => globalThis.clearInterval(timer);
  }, [assetKey, refresh]);

  useEffect(() => {
    const assets = assetKey ? assetKey.split(',').filter(Boolean) : [];
    if (assets.length === 0) {
      setBooksByAsset({});
      return;
    }

    let cancelled = false;
    setBooksByAsset((current) => {
      const next: PositionOrderbookMap = {};
      for (const asset of assets) {
        next[asset] = { book: current[asset]?.book ?? null, loading: true, error: null };
      }
      return next;
    });

    void Promise.all(assets.map(async (asset) => {
      try {
        const book = await fetchOrderbook(asset);
        return { asset, book, error: null };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Could not load sell quote';
        return { asset, book: null, error: message };
      }
    })).then((results) => {
      if (cancelled) return;
      setBooksByAsset((current) => {
        const next: PositionOrderbookMap = { ...current };
        for (const result of results) {
          next[result.asset] = { book: result.book, loading: false, error: result.error };
        }
        return next;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [assetKey, refreshNonce]);

  const quotes = useMemo(() => {
    const next: PositionSellQuoteMap = {};
    for (const position of positions) {
      if (!position.asset) continue;
      const state = booksByAsset[position.asset];
      next[positionSellQuoteKey(position)] = buildPositionSellQuote(
        position,
        state?.book ?? null,
        position.size,
        state?.loading ?? false,
        state?.error ?? null,
      );
    }
    return next;
  }, [booksByAsset, positions]);

  const loading = Object.values(booksByAsset).some((state) => state?.loading);

  return {
    quotes,
    booksByAsset,
    loading,
    refresh,
  };
}
