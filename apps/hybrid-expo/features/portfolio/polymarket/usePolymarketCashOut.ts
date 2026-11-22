/**
 * usePolymarketCashOut — cash out, redeem ("collect") and cancel for the
 * Polymarket profile screen (#738, extracted verbatim from
 * `polymarket.portfolio.tsx`).
 *
 * Cash out is the unchanged `CashOutConfirmModal` → `placeBet` SELL FOK flow;
 * redemption runs through `redeemPosition` + `redeemErrors`; cancel flags the
 * order via the CLOB and flags the activity as stale when the refresh fails.
 */

import { useCallback, useState } from 'react';
import { Alert } from 'react-native';

import {
  cancelOrder,
  fetchOpenOrders,
  placeBet,
  redeemPosition,
} from '@/features/polymarket/polymarket.api';
import type { OpenOrder, PortfolioPosition } from '@/features/polymarket/polymarket.api';
import type { PolymarketDataFreshness } from '@/features/polymarket/polymarketActivityState';
import { formatRedeemError, logRedeemError } from '@/features/polymarket/redeemErrors';
import { positionKey } from '@/features/portfolio/polymarket/polymarket.format';
import type { PolymarketWallet } from '@/hooks/usePolymarketWallet';

type OrderUpdate = OpenOrder[] | ((previous: OpenOrder[]) => OpenOrder[]);
type FreshnessUpdate =
  | PolymarketDataFreshness
  | ((previous: PolymarketDataFreshness) => PolymarketDataFreshness);

interface UsePolymarketCashOutOptions {
  poly: PolymarketWallet;
  loadPortfolio: () => Promise<void>;
  actionsDisabled: boolean;
  setOpenOrders: (update: OrderUpdate) => void;
  setActivityFreshness: (update: FreshnessUpdate) => void;
}

export function usePolymarketCashOut({
  poly,
  loadPortfolio,
  actionsDisabled,
  setOpenOrders,
  setActivityFreshness,
}: UsePolymarketCashOutOptions) {
  const [cashOutPosition, setCashOutPosition] = useState<PortfolioPosition | null>(null);
  const [cashOutSubmitting, setCashOutSubmitting] = useState(false);

  const [cancellingId, setCancellingId] = useState<string | null>(null);

  // Redeem flow state, lifted from the retired ProfilePortfolioTabs component.
  const [redeemingId, setRedeemingId] = useState<string | null>(null);
  const [redeemError, setRedeemError] = useState<{ id: string; message: string } | null>(null);

  const clearCashOutPosition = useCallback(() => {
    setCashOutPosition(null);
  }, []);

  const handleCashOut = useCallback((position: PortfolioPosition) => {
    setCashOutPosition(position);
  }, []);

  const handleConfirmCashOut = useCallback(async (size: number, limitPrice: number) => {
    const position = cashOutPosition;
    if (!position || cashOutSubmitting) return;

    if (!position.asset) {
      Alert.alert('Cash out failed', 'Missing token ID for this position.');
      return;
    }

    if (!poly.canSignLocally) {
      try {
        await poly.enable();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Failed to enable Polymarket account';
        Alert.alert('Wallet', msg);
        return;
      }
    }

    if (!poly.client) {
      Alert.alert('Cash out failed', 'Polymarket account not ready.');
      return;
    }

    setCashOutSubmitting(true);
    try {
      const result = await placeBet(poly.client, {
        tokenID: position.asset,
        price: limitPrice,
        size,
        side: 'SELL',
        orderType: 'FOK',
      });
      if (!result.success) throw new Error(result.error || 'Cash out failed');

      setCashOutPosition(null);
      await loadPortfolio();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      Alert.alert('Cash out failed', msg);
    } finally {
      setCashOutSubmitting(false);
    }
  }, [cashOutPosition, cashOutSubmitting, loadPortfolio, poly]);

  const handleCancel = useCallback(async (orderId: string) => {
    if (!poly.client) return;
    setCancellingId(orderId);
    try {
      const result = await cancelOrder(poly.client, orderId);
      if (result.ok) {
        setOpenOrders((prev) => prev.map((order) =>
          order.id === orderId ? { ...order, status: 'cancel_requested' } : order
        ));
        void fetchOpenOrders(poly.client)
          .then(setOpenOrders)
          .catch(() => {
            setActivityFreshness((previous) => ({
              ...previous,
              stale: true,
              error: 'Could not refresh',
            }));
          });
      } else {
        Alert.alert('Cancel failed', result.error ?? 'Unknown error');
      }
    } catch {
      Alert.alert('Cancel failed', 'Network error');
    } finally {
      setCancellingId(null);
    }
  }, [poly.client, setActivityFreshness, setOpenOrders]);

  async function collect(position: PortfolioPosition) {
    const id = positionKey(position);
    if (actionsDisabled || !poly.client || redeemingId) return;
    setRedeemingId(id);
    setRedeemError(null);
    try {
      const result = await redeemPosition(poly.client, {
        conditionId: position.conditionId,
      });
      if (!result.ok) throw new Error(result.error || 'Collect failed');
      await loadPortfolio();
    } catch (error) {
      logRedeemError('profile-positions-tab', error, position);
      setRedeemError({ id, message: formatRedeemError(error) });
    } finally {
      setRedeemingId(null);
    }
  }

  return {
    cashOutPosition,
    cashOutSubmitting,
    clearCashOutPosition,
    handleCashOut,
    handleConfirmCashOut,
    cancellingId,
    handleCancel,
    redeemingId,
    redeemError,
    collect,
  };
}
