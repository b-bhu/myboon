/**
 * Phoenix Orders tab — pure helpers (issue #850, design wallet.html frame
 * "Phoenix · Orders", component ".pc[data-t=ord]").
 *
 * - the orders request URL and the state transition for one response (same
 *   trust rule as perp-positions.ts: a failed refresh keeps the held list);
 * - the card strings for one take-profit or stop-loss order.
 *
 * A null number is unknown, not zero, and shows NO_DATA. Plain module for
 * tsx --test (phoenix-orders.test.ts).
 */

import { NO_DATA } from '@/lib/format';
import type { PhoenixOrdersResponse, WalletPhoenixOrder } from '@myboon/shared/wallet-summary';
import { perpPrice } from './phoenix-positions';
import { usd } from './phoenix-top';

/** What the hook holds: the last good load (nothing before one) and its error. */
export interface PhoenixOrdersState {
  /** Orders from the last good load; null until that load lands. */
  orders: WalletPhoenixOrder[] | null;
  /** Human-readable failure text; null after a good load. */
  error: string | null;
}

/** The orders request URL, or null when there is no address to ask for. */
export function phoenixOrdersUrl(baseUrl: string, solana: string | null): string | null {
  if (!solana) return null;
  const params = new URLSearchParams({ solana });
  return `${baseUrl}/wallet/phoenix/orders?${params.toString()}`;
}

/**
 * Fold one response into the state: `ok` and `not_connected` take the array;
 * `unavailable` and a body without `status` (or null) set the error and keep
 * the held list.
 */
export function applyPhoenixOrdersResponse(
  previous: PhoenixOrdersState,
  payload: PhoenixOrdersResponse | null,
): PhoenixOrdersState {
  if (payload && (payload.status === 'ok' || payload.status === 'not_connected')) {
    return { orders: Array.isArray(payload.orders) ? payload.orders : [], error: null };
  }
  const fallback =
    payload && payload.status === 'unavailable'
      ? 'Phoenix orders are unavailable.'
      : 'Phoenix orders request failed.';
  return { ...previous, error: (payload && payload.error) || fallback };
}

export interface PhoenixOrderCardFigures {
  /** "SOL-PERP · Take profit". */
  title: string;
  /** "Mark ≥ 175.00"; "Mark" alone when the price or the side is unknown. */
  trigger: string;
  /** "+$33.23" or NO_DATA. */
  pnl: string;
  pnlTone: 'up' | 'down' | null;
}

/**
 * "≥" for a take profit on a long and a stop loss on a short; "≤" for a
 * stop loss on a long and a take profit on a short; null side → no sign.
 */
export function triggerSign(
  kind: WalletPhoenixOrder['kind'],
  positionSide: WalletPhoenixOrder['positionSide'],
): '≥' | '≤' | null {
  if (positionSide === null) return null;
  return (kind === 'take_profit') === (positionSide === 'long') ? '≥' : '≤';
}

export function phoenixOrderFigures(order: WalletPhoenixOrder): PhoenixOrderCardFigures {
  const sign = triggerSign(order.kind, order.positionSide);
  const price = order.triggerPriceUsd === null ? NO_DATA : perpPrice(order.triggerPriceUsd);
  const pnl = order.pnlAtTriggerUsd;
  return {
    title: `${order.symbol} · ${order.kind === 'take_profit' ? 'Take profit' : 'Stop loss'}`,
    trigger: sign === null ? `Mark ${price}` : `Mark ${sign} ${price}`,
    pnl: pnl === null ? NO_DATA : (pnl < 0 ? '−' : '+') + usd(pnl),
    pnlTone: pnl === null ? null : pnl < 0 ? 'down' : 'up',
  };
}
