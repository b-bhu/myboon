/**
 * Polymarket body for the shared action panel — PURE core.
 *
 * Ports the submit path of PolymarketMarketDetailScreen.submitOrder verbatim:
 * wallet-session gate (poly.enable → poly.client), fresh orderbook quote,
 * composer-v2 limit branch (GTD with the market's deadline) vs market branch
 * (FOK against the executable book quote), minimum-order guardrail,
 * pending-open-order bookkeeping, cash-balance debit and the
 * picks/balance/orderbook refresh fan-out with follow-up reconcile. The shell
 * owns single-flight (submitting state); the screen's submitInFlightRef is
 * therefore not re-implemented here. No execution-module change.
 *
 * Everything here is node-safe by design (no react-native) so the colocated
 * test can import it; the .tsx sibling is the thin UI shim.
 */

import type {
  ActionSummaryRow,
  ActionVenueAdapter,
} from '@/features/markets/action/action.contract';
import { formatActionAmount } from '@/features/markets/action/action.contract';
import { buildExecutableBuyQuote } from '@/features/polymarket/orderbookQuote';
import { getMinimumOrderGuardrail } from '@/features/polymarket/minimumOrderSize';
import { makePendingOpenOrder } from '@/features/polymarket/pendingOpenOrders';
import type { OpenOrder } from '@/features/polymarket/polymarket.api';
import type {
  fetchClobBalance,
  fetchOrderbook,
  placeBet,
} from '@/features/polymarket/polymarket.api';
import type { getPolymarketOrderGuardrail } from '@/features/polymarket/polymarketActivityState';

/** Body state: composer-v2 mode plus the limit price, when limiting. */
export interface PolymarketActionBody {
  mode: 'market' | 'limit';
  /** Limit price in cents, as typed (e.g. '57'). Empty string for market mode. */
  limitPriceCentsText: string;
}

/** Client the screen gets from usePolymarketWallet — derive from placeBet's own signature. */
type PolymarketActionClient = Parameters<typeof placeBet>[0];

/**
 * Everything the screen closes over when submitting, passed through. The
 * screen owns all state; this adapter never recreates screen logic.
 */
export interface PolymarketActionDeps {
  /** Screen's usePolymarketWallet handle. */
  poly: {
    canSignLocally: boolean;
    enable: () => Promise<unknown>;
    client: PolymarketActionClient;
  };
  tokenID: string;
  outcomeLabel: string;
  slug: string;
  /** The guardrail's price anchors: displayed quote price + latest clob price. */
  selectedPrice: number | null;
  latestPrice: number;
  marketActive: boolean;
  /** Market deadline for GTD limit orders (detail.endDate). */
  endDate: string | null;
  /** Screen-owned balance state, debited optimistically on fill then refreshed. */
  cashBalance: number | null;
  setCashBalance: (next: number | null | ((prev: number | null) => number | null)) => void;
  /** Screen-owned pending-open-order list state. */
  setPendingOpenOrders: (updater: (prev: OpenOrder[]) => OpenOrder[]) => void;
  /** Live book for the token — the quote + fresh-quote submit use it. */
  fetchOrderbook: typeof fetchOrderbook;
  /** CLOB cash balance; screen passes its own fetch for testability. */
  fetchClobBalance: typeof fetchClobBalance;
  /** Order submit — injected so the core stays node-safe (api module is not). */
  placeBet: typeof placeBet;
  /** Pre-submit guardrail (market closed / cash / minimum checks). */
  guardrail: typeof getPolymarketOrderGuardrail;
  /** Post-fill refresh fan-out, exactly what the screen runs. */
  loadPicks: () => Promise<unknown>;
  refreshOrderbook: () => Promise<unknown>;
  scheduleFollowUpReconcile: () => void;
}

function limitCents(body: PolymarketActionBody): number {
  if (body.mode !== 'limit') return 0;
  const value = Math.round(Number(body.limitPriceCentsText));
  return Number.isFinite(value) ? value : 0;
}

function centsLabel(price: number): string {
  return `${Math.round(price * 100)}¢`;
}

export function createPolymarketActionAdapter(
  deps: PolymarketActionDeps,
): ActionVenueAdapter<PolymarketActionBody, void> {
  return {
    venueId: 'polymarket',
    kind: 'prediction',
    label: 'Polymarket',
    amountLabel: () => 'Amount (USD)',
    amountPrefix: () => '$',
    amountSuffix: () => null,

    confirm: () => ({ label: 'Swipe to place order', accent: 'pos' }),

    validate: (body, context) => {
      if (!deps.tokenID) return { title: 'No token ID for this outcome', detail: null };
      if (!(deps.latestPrice > 0 && deps.latestPrice < 1)) {
        return { title: 'Invalid price', detail: null };
      }
      const amount = context.amount.amountValue;
      if (amount === null || amount <= 0) {
        return { title: 'Enter an amount', detail: null };
      }
      if (body.mode === 'limit' && limitCents(body) <= 0) {
        return { title: 'Enter a limit price', detail: null };
      }
      const guardrail = deps.guardrail({
        amount,
        availableCash: deps.cashBalance,
        selectedPrice: deps.selectedPrice,
        latestPrice: deps.latestPrice,
        marketActive: deps.marketActive,
        submitting: false,
      });
      if (guardrail?.blocking) {
        return { title: guardrail.title, detail: guardrail.message ?? null };
      }
      return null;
    },

    quote: async (body, context) => {
      const amount = context.amount.amountValue;
      if (amount === null || amount <= 0) {
        return { rows: [], loading: false, unavailableReason: 'Enter an amount first' };
      }
      try {
        const book = await deps.fetchOrderbook(deps.tokenID);
        if (body.mode === 'limit') {
          const cents = limitCents(body);
          const shares = cents > 0 ? amount / (cents / 100) : null;
          const rows: readonly ActionSummaryRow[] = [
            { key: 'LIMIT PRICE', value: cents > 0 ? `${cents}¢` : '—' },
            {
              key: 'EST. SHARES',
              value:
                shares !== null
                  ? formatActionAmount(shares, { maxDecimals: 2 })
                  : '—',
            },
          ];
          return { rows, loading: false, unavailableReason: null };
        }
        const quote = buildExecutableBuyQuote(book, amount);
        if (!quote.executable || quote.limitPrice === null || quote.shares <= 0) {
          return {
            rows: [],
            loading: false,
            unavailableReason: 'Not enough liquidity at the current price',
          };
        }
        const rows: readonly ActionSummaryRow[] = [
          { key: 'AVG PRICE', value: quote.averagePrice !== null ? centsLabel(quote.averagePrice) : '—' },
          {
            key: 'EST. SHARES',
            value: formatActionAmount(quote.shares, { maxDecimals: 2 }),
          },
        ];
        return { rows, loading: false, unavailableReason: null };
      } catch {
        return { rows: [], loading: false, unavailableReason: 'Orderbook unavailable' };
      }
    },

    submit: async (body, context) => {
      const amount = context.amount.amountValue;
      if (amount === null || amount <= 0) {
        return { status: 'rejected', message: 'Enter an amount first.' };
      }
      try {
        // Ensure the Polymarket session is set up against the resolved EVM signer
        if (!deps.poly.canSignLocally) {
          await deps.poly.enable();
        }
        if (!deps.poly.client) throw new Error('Wallet session not ready');

        const freshBook = await deps.fetchOrderbook(deps.tokenID).catch(() => null);
        const quote = buildExecutableBuyQuote(freshBook, amount);
        const effectiveLimitCents = limitCents(body) > 0 ? limitCents(body) : null;
        if (
          effectiveLimitCents === null &&
          (!quote.executable || quote.limitPrice === null || quote.shares <= 0)
        ) {
          return {
            status: 'rejected',
            message:
              'Not filled: not enough liquidity at the current price. Try a smaller amount or refresh the market.',
          };
        }
        const effectivePrice =
          effectiveLimitCents !== null ? effectiveLimitCents / 100 : quote.averagePrice;
        const effectiveShares =
          effectiveLimitCents !== null ? amount / (effectiveLimitCents / 100) : quote.shares;
        const minimumGuardrail = getMinimumOrderGuardrail({
          orderSize: effectiveShares,
          minimumOrderSize: freshBook?.minOrderSize,
          executionPrice: effectivePrice,
        });
        if (minimumGuardrail) {
          return {
            status: 'rejected',
            message: `${minimumGuardrail.title} — ${minimumGuardrail.message}`,
          };
        }

        if (effectiveLimitCents !== null) {
          const limitPrice = effectiveLimitCents / 100;
          const limitShares = amount / limitPrice;
          const expirationMs = deps.endDate === null ? NaN : Date.parse(deps.endDate);
          if (!Number.isFinite(expirationMs) || expirationMs <= Date.now() + 60_000) {
            return {
              status: 'rejected',
              message:
                'This market has no future deadline for a limit order. Use a market order instead.',
            };
          }
          const resultLimit = await deps.placeBet(deps.poly.client, {
            tokenID: deps.tokenID,
            price: limitPrice,
            size: limitShares,
            side: 'BUY',
            orderType: 'GTD',
            expiration: Math.floor(expirationMs / 1_000),
          });
          if (!resultLimit.success) throw new Error(resultLimit.error || 'Order failed');
          const pendingLimit = makePendingOpenOrder({
            id: resultLimit.orderID ?? resultLimit.operationId,
            slug: deps.slug,
            tokenID: deps.tokenID,
            price: limitPrice,
            size: limitShares,
            outcome: deps.outcomeLabel,
          });
          deps.setPendingOpenOrders((prev) => [
            pendingLimit,
            ...prev.filter((o) => o.id !== pendingLimit.id),
          ]);
          deps.setCashBalance((prev) => (prev === null ? prev : Math.max(prev - amount, 0)));
          await Promise.allSettled([
            deps.loadPicks(),
            deps
              .fetchClobBalance(deps.poly.client)
              .then((b) => deps.setCashBalance(b?.balance ?? null)),
            deps.refreshOrderbook(),
          ]);
          deps.scheduleFollowUpReconcile();
          return {
            status: 'submitted',
            message: `Placed: $${formatActionAmount(amount)} on ${deps.outcomeLabel}.`,
            closeAfter: true,
          };
        }

        if (!quote.executable || quote.limitPrice === null || quote.shares <= 0) {
          return {
            status: 'rejected',
            message:
              'Not filled: not enough liquidity at the current price. Try a smaller amount or refresh the market.',
          };
        }
        const result = await deps.placeBet(deps.poly.client, {
          tokenID: deps.tokenID,
          price: quote.limitPrice,
          size: quote.shares,
          amount,
          side: 'BUY',
          orderType: 'FOK',
        });
        if (!result.success) throw new Error(result.error || 'Order failed');

        const pendingOrder = makePendingOpenOrder({
          id: result.orderID ?? result.operationId,
          slug: deps.slug,
          tokenID: deps.tokenID,
          price: result.executionPrice ?? result.estimatedPrice ?? quote.limitPrice,
          size: result.shares ?? quote.shares,
          outcome: deps.outcomeLabel,
        });
        deps.setPendingOpenOrders((prev) => [
          pendingOrder,
          ...prev.filter((order) => order.id !== pendingOrder.id),
        ]);
        deps.setCashBalance((prev) => (prev === null ? prev : Math.max(prev - amount, 0)));
        await Promise.allSettled([
          deps.loadPicks(),
          deps
            .fetchClobBalance(deps.poly.client)
            .then((balance) => deps.setCashBalance(balance?.balance ?? null)),
          deps.refreshOrderbook(),
        ]);
        deps.scheduleFollowUpReconcile();
        return {
          status: 'submitted',
          message: `Placed: $${formatActionAmount(amount)} on ${deps.outcomeLabel}.`,
          closeAfter: true,
        };
      } catch (err) {
        return {
          status: 'rejected',
          message: err instanceof Error ? err.message : 'Order failed',
        };
      }
    },
  };
}
