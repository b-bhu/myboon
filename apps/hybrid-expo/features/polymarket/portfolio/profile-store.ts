import { useCallback, useSyncExternalStore } from 'react';
import type { OpenOrder, PortfolioData } from '@/features/polymarket/polymarket.api';
import type { PolymarketDataFreshness } from '@/features/polymarket/polymarketActivityState';

type StateUpdater<T> = T | ((previous: T) => T);

export interface PolymarketProfileSnapshot {
  walletKey: string;
  portfolio: PortfolioData | null;
  cashBalance: number | null;
  openOrders: OpenOrder[];
  portfolioLoading: boolean;
  polymarketUnavailable: boolean;
  activityFreshness: PolymarketDataFreshness;
  hasLoaded: boolean;
}

const listeners = new Set<() => void>();
const emptySnapshots = new Map<string, PolymarketProfileSnapshot>();

function emptySnapshot(walletKey: string): PolymarketProfileSnapshot {
  const existing = emptySnapshots.get(walletKey);
  if (existing) return existing;
  const created: PolymarketProfileSnapshot = {
    walletKey,
    portfolio: null,
    cashBalance: null,
    openOrders: [],
    portfolioLoading: false,
    polymarketUnavailable: false,
    activityFreshness: {
      lastUpdatedAt: null,
      loading: false,
      stale: false,
      error: null,
    },
    hasLoaded: false,
  };
  emptySnapshots.set(walletKey, created);
  return created;
}

let snapshot = emptySnapshot('disconnected');

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(): void {
  listeners.forEach((listener) => listener());
}

function snapshotFor(walletKey: string): PolymarketProfileSnapshot {
  return snapshot.walletKey === walletKey ? snapshot : emptySnapshot(walletKey);
}

function updateSnapshot(
  walletKey: string,
  update: Partial<PolymarketProfileSnapshot> | ((current: PolymarketProfileSnapshot) => Partial<PolymarketProfileSnapshot>),
): void {
  const current = snapshotFor(walletKey);
  const patch = typeof update === 'function' ? update(current) : update;
  snapshot = { ...current, ...patch, walletKey };
  emit();
}

function resolve<T>(current: T, update: StateUpdater<T>): T {
  return typeof update === 'function'
    ? (update as (previous: T) => T)(current)
    : update;
}

export function usePolymarketProfileStore(walletKey: string) {
  const state = useSyncExternalStore(
    subscribe,
    () => snapshotFor(walletKey),
    () => snapshotFor(walletKey),
  );

  const setPortfolio = useCallback((update: StateUpdater<PortfolioData | null>) => {
    updateSnapshot(walletKey, (current) => ({ portfolio: resolve(current.portfolio, update) }));
  }, [walletKey]);

  const setCashBalance = useCallback((update: StateUpdater<number | null>) => {
    updateSnapshot(walletKey, (current) => ({ cashBalance: resolve(current.cashBalance, update) }));
  }, [walletKey]);

  const setOpenOrders = useCallback((update: StateUpdater<OpenOrder[]>) => {
    updateSnapshot(walletKey, (current) => ({ openOrders: resolve(current.openOrders, update) }));
  }, [walletKey]);

  const setPortfolioLoading = useCallback((update: StateUpdater<boolean>) => {
    updateSnapshot(walletKey, (current) => ({ portfolioLoading: resolve(current.portfolioLoading, update) }));
  }, [walletKey]);

  const setPolymarketUnavailable = useCallback((update: StateUpdater<boolean>) => {
    updateSnapshot(walletKey, (current) => ({ polymarketUnavailable: resolve(current.polymarketUnavailable, update) }));
  }, [walletKey]);

  const setActivityFreshness = useCallback((update: StateUpdater<PolymarketDataFreshness>) => {
    updateSnapshot(walletKey, (current) => ({ activityFreshness: resolve(current.activityFreshness, update) }));
  }, [walletKey]);

  const markLoaded = useCallback(() => {
    updateSnapshot(walletKey, { hasLoaded: true });
  }, [walletKey]);

  const reset = useCallback(() => {
    snapshot = emptySnapshot(walletKey);
    emit();
  }, [walletKey]);

  return {
    ...state,
    setPortfolio,
    setCashBalance,
    setOpenOrders,
    setPortfolioLoading,
    setPolymarketUnavailable,
    setActivityFreshness,
    markLoaded,
    reset,
  };
}
