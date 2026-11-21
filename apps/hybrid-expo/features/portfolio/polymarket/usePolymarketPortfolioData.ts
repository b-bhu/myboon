/**
 * usePolymarketPortfolioData — the Polymarket profile screen's data layer
 * (#738, extracted verbatim from `polymarket.portfolio.tsx`).
 *
 * Owns the shared wallet-scoped profile store plus everything that feeds it:
 * `loadPortfolio`, both quiet refreshes, the user stream, the focus refresh,
 * the 15s/7s activity intervals, `resetWalletScopedState` and the
 * load-on-enable effect. Pure move — poll intervals, stream wiring and reset
 * ordering are unchanged.
 */

import { useCallback, useEffect, useRef } from 'react';
import { useFocusEffect } from 'expo-router';

import {
  fetchClobBalance,
  fetchOpenOrders,
  fetchPortfolio,
} from '@/features/polymarket/polymarket.api';
import {
  applyPolymarketUserEvent,
  isPolymarketTradeEvent,
  usePolymarketUserStream,
} from '@/features/polymarket/usePolymarketUserStream';
import { usePolymarketProfileStore } from '@/features/polymarket/portfolio/profile-store';
import { useFocusedAppStateInterval } from '@/hooks/useFocusedAppStateInterval';
import type { PolymarketWallet } from '@/hooks/usePolymarketWallet';

interface UsePolymarketPortfolioDataOptions {
  poly: PolymarketWallet;
  walletScopedKey: string;
  isEnabled: boolean;
  /** Invoked by `resetWalletScopedState` so sibling hooks clear their state too. */
  onWalletReset?: () => void;
}

export function usePolymarketPortfolioData({
  poly,
  walletScopedKey,
  isEnabled,
  onWalletReset,
}: UsePolymarketPortfolioDataOptions) {
  // Account data belongs to the Polymarket profile domain, not the route
  // instance. The shared wallet-scoped store survives navigation while still
  // resetting whenever the active signer/deposit wallet changes.
  const {
    portfolio,
    cashBalance,
    openOrders,
    portfolioLoading,
    polymarketUnavailable,
    activityFreshness,
    hasLoaded: profileHasLoaded,
    setPortfolio,
    setCashBalance,
    setOpenOrders,
    setPortfolioLoading,
    setPolymarketUnavailable,
    setActivityFreshness,
    markLoaded: markProfileLoaded,
    reset: resetProfileStore,
  } = usePolymarketProfileStore(walletScopedKey);

  const onWalletResetRef = useRef(onWalletReset);
  useEffect(() => {
    onWalletResetRef.current = onWalletReset;
  });
  const walletScopedKeyRef = useRef(walletScopedKey);
  const portfolioRefreshInFlight = useRef(false);
  const ordersRefreshInFlight = useRef(false);

  const resetWalletScopedState = useCallback(() => {
    resetProfileStore();
    onWalletResetRef.current?.();
    portfolioRefreshInFlight.current = false;
    ordersRefreshInFlight.current = false;
  }, [resetProfileStore]);

  useEffect(() => {
    if (walletScopedKeyRef.current === walletScopedKey) return;
    walletScopedKeyRef.current = walletScopedKey;
    resetWalletScopedState();
  }, [walletScopedKey, resetWalletScopedState]);

  const loadPortfolio = useCallback(async () => {
    if (!poly.polygonAddress || !poly.client) return;
    const requestKey = walletScopedKeyRef.current;
    setActivityFreshness((prev) => ({ ...prev, loading: true, error: null }));
    const [portfolioResult, balanceResult, ordersResult] = await Promise.allSettled([
      fetchPortfolio(poly.client),
      fetchClobBalance(poly.client),
      fetchOpenOrders(poly.client),
    ]);
    const portfolioData = portfolioResult.status === 'fulfilled' ? portfolioResult.value : null;
    const balanceData = balanceResult.status === 'fulfilled' ? balanceResult.value : null;
    const ordersData = ordersResult.status === 'fulfilled' ? ordersResult.value : null;
    if (walletScopedKeyRef.current !== requestKey) return;
    if (portfolioData) setPortfolio(portfolioData);
    // A missing balance is the only failure signal exposed by this CLOB read.
    // Preserve the last known orders with it: a 401 or transient CLOB failure
    // must not make positions appear to have vanished while reconnecting.
    if (ordersData && balanceData) setOpenOrders(ordersData);
    if (balanceData) {
      setCashBalance(balanceData.balance);
      setPolymarketUnavailable(false);
    } else {
      setCashBalance(null);
      setPolymarketUnavailable(true);
    }
    const failed = portfolioResult.status === 'rejected'
      || balanceResult.status === 'rejected'
      || balanceData === null
      || ordersResult.status === 'rejected';
    setActivityFreshness((previous) => ({
      lastUpdatedAt: failed ? previous.lastUpdatedAt : Date.now(),
      loading: false,
      stale: failed,
      error: failed ? 'Could not refresh' : null,
    }));
    markProfileLoaded();
  }, [
    markProfileLoaded,
    poly.client,
    poly.polygonAddress,
    setActivityFreshness,
    setCashBalance,
    setOpenOrders,
    setPortfolio,
    setPolymarketUnavailable,
  ]);

  const refreshPortfolioQuietly = useCallback(async () => {
    if (!poly.polygonAddress || !poly.client) return;
    const requestKey = walletScopedKeyRef.current;
    if (portfolioRefreshInFlight.current) return;
    portfolioRefreshInFlight.current = true;
    try {
      const [portfolioResult, balanceResult] = await Promise.allSettled([
        fetchPortfolio(poly.client),
        fetchClobBalance(poly.client),
      ]);
      const portfolioData = portfolioResult.status === 'fulfilled' ? portfolioResult.value : null;
      const balanceData = balanceResult.status === 'fulfilled' ? balanceResult.value : null;
      if (walletScopedKeyRef.current !== requestKey) return;

      if (portfolioData) setPortfolio(portfolioData);
      if (balanceData) {
        setCashBalance(balanceData.balance);
        setPolymarketUnavailable(false);
      }

      const failed = portfolioResult.status === 'rejected'
        || balanceResult.status === 'rejected'
        || balanceData === null;
      setActivityFreshness((prev) => ({
        lastUpdatedAt: failed ? prev.lastUpdatedAt : Date.now(),
        loading: false,
        stale: failed,
        error: failed ? 'Could not refresh' : null,
      }));
    } finally {
      portfolioRefreshInFlight.current = false;
    }
  }, [
    poly.client,
    poly.polygonAddress,
    setActivityFreshness,
    setCashBalance,
    setPortfolio,
    setPolymarketUnavailable,
  ]);

  const refreshOpenOrdersQuietly = useCallback(async () => {
    if (!poly.client) return;
    const requestKey = walletScopedKeyRef.current;
    if (ordersRefreshInFlight.current) return;
    ordersRefreshInFlight.current = true;
    try {
      const orders = await fetchOpenOrders(poly.client);
      if (walletScopedKeyRef.current !== requestKey) return;
      setOpenOrders(orders);
    } catch {
      setActivityFreshness((prev) => ({ ...prev, stale: true, error: 'Could not refresh' }));
    } finally {
      ordersRefreshInFlight.current = false;
    }
  }, [poly.client, setActivityFreshness, setOpenOrders]);

  const realtimeStatus = usePolymarketUserStream(
    isEnabled ? poly.client : null,
    (event) => {
      setOpenOrders((orders) => applyPolymarketUserEvent(orders, event));
      if (isPolymarketTradeEvent(event)) void refreshPortfolioQuietly();
    },
    loadPortfolio,
  );

  // Fetch portfolio when enabled
  useEffect(() => {
    const requestKey = walletScopedKeyRef.current;
    if (!isEnabled || !poly.polygonAddress) {
      resetWalletScopedState();
      setPortfolioLoading(false);
      return;
    }
    // Keep a previously loaded wallet snapshot visible while its fresh data is
    // requested. Full-page loading is reserved for the first load only.
    if (!profileHasLoaded) setPortfolioLoading(true);
    loadPortfolio().finally(() => {
      if (walletScopedKeyRef.current === requestKey) setPortfolioLoading(false);
    });
    // `profileHasLoaded` is intentionally a point-in-time decision for this
    // wallet activation. Adding it below would trigger a duplicate request when
    // the first load marks the shared snapshot ready.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isEnabled,
    loadPortfolio,
    poly.polygonAddress,
    resetWalletScopedState,
    setPortfolioLoading,
  ]);

  // Refresh when screen regains focus (e.g. returning from position detail after sell)
  const hasMounted = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (hasMounted.current && isEnabled && poly.polygonAddress) {
        void loadPortfolio();
      }
      hasMounted.current = true;
    }, [isEnabled, loadPortfolio, poly.polygonAddress]),
  );

  useFocusedAppStateInterval(() => void refreshPortfolioQuietly(), 15_000, {
    enabled: Boolean(isEnabled && poly.polygonAddress),
    resetKey: `${poly.polygonAddress ?? ''}:${poly.tradingAddress ?? ''}`,
  });

  useFocusedAppStateInterval(() => void refreshOpenOrdersQuietly(), 7_000, {
    enabled: Boolean(isEnabled && poly.polygonAddress),
    resetKey: poly.polygonAddress,
  });

  return {
    portfolio,
    cashBalance,
    openOrders,
    portfolioLoading,
    polymarketUnavailable,
    activityFreshness,
    realtimeStatus,
    loadPortfolio,
    resetWalletScopedState,
    setOpenOrders,
    setActivityFreshness,
    setPolymarketUnavailable,
  };
}
