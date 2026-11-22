/**
 * Polymarket portfolio Orders tab model (#736), moved verbatim from
 * `polymarket.portfolio.tsx`: the open-orders row builder and the reserved
 * note shown under the tab. A plain builder — the screen keeps the cancel
 * callback and the sorted orders. Pure move — no behaviour change.
 */

import type { ReactNode } from 'react';
import { Text } from 'react-native';

import { truncateUsd } from '@/features/polymarket/formatPolymarketMoney';
import { getPolymarketActivityStatusLabel } from '@/features/polymarket/polymarketActivityState';
import type { OpenOrder } from '@/features/polymarket/polymarket.api';
import { formatAge, orderCost } from '@/features/portfolio/polymarket/polymarket.format';
import { styles } from '@/features/portfolio/polymarket/polymarket.portfolio.styles';
import type { VenuePortfolioRow } from '@/features/portfolio/venue-portfolio.contract';

export interface PolymarketOrdersTabProps {
  sortedOrders: OpenOrder[];
  cancellingId: string | null;
  actionsDisabled: boolean;
  onCancel: (orderId: string) => Promise<void>;
}

export interface PolymarketOrdersTabRows {
  orderRows: VenuePortfolioRow[];
  reservedNote: ReactNode;
}

export function buildPolymarketOrdersTab({
  sortedOrders,
  cancellingId,
  actionsDisabled,
  onCancel,
}: PolymarketOrdersTabProps): PolymarketOrdersTabRows {
  const orderRows = sortedOrders.map((order) => {
    const cost = orderCost(order);
    const waitingLabel = order.status === 'cancel_requested'
      ? getPolymarketActivityStatusLabel('cancel_requested')
      : order.status === 'local-pending'
        ? getPolymarketActivityStatusLabel('syncing')
        : getPolymarketActivityStatusLabel('waiting_to_match');
    return {
      key: order.id,
      title: order.market || 'Polymarket',
      titleAccent: order.outcome || undefined,
      subtitle: [
        `${Math.round((Number.parseFloat(order.price) || 0) * 100)}¢`,
        cost === null ? null : `${truncateUsd(cost)} reserved`,
        formatAge(order.created_at),
      ].filter(Boolean).join(' · '),
      value: waitingLabel,
      actionLabel:
        cancellingId === order.id ? 'Cancelling…' : order.status === 'cancel_requested' ? 'Requested' : 'Cancel',
      actionPending: cancellingId === order.id,
      actionDisabled: actionsDisabled || order.status === 'cancel_requested',
      onActionPress: () => void onCancel(order.id),
      onPress: undefined,
    };
  });

  const reservedNote = sortedOrders.length > 0 ? (
    <Text style={styles.showingNote}>
      Reserved for these orders: {truncateUsd(sortedOrders.reduce((sum, order) => sum + (orderCost(order) ?? 0), 0))} pUSD
    </Text>
  ) : null;

  return { orderRows, reservedNote };
}
