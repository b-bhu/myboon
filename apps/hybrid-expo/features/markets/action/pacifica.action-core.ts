/**
 * Pacifica body for the shared action panel — PURE core.
 *
 * Ports the submit path of PacificaMarketDetailScreen verbatim: limit orders
 * via placeLimitOrder, market orders via placeOrder (slippage '1') followed by
 * setTPSL when TP/SL were entered, PACIFIC_BUILDER_CODE builder code
 * throughout. No execution-module change. Everything here is node-safe by
 * design (no react-native) so the colocated test can import it; the .tsx
 * sibling is the thin UI shim.
 */

import type {
  ActionPanelContext,
  ActionVenueAdapter,
  ActionValidation,
} from '@/features/markets/action/action.contract';
import { formatActionAmount } from '@/features/markets/action/action.contract';
import {
  placeLimitOrder,
  placeOrder,
  setTPSL,
} from '@/features/perps/perps.signed-api';
import { PACIFIC_BUILDER_CODE } from '@/features/perps/pacific.config';

export interface PacificaActionBody {
  side: 'long' | 'short';
  orderType: 'market' | 'limit';
  limitPriceText: string;
  tpPriceText: string;
  slPriceText: string;
}

/** The screen passes wallet.signMessage straight through — reuse its exact type. */
type PacificaSignMessage = Parameters<typeof placeOrder>[2];

export interface PacificaActionDeps {
  symbol: string;
  /** availableBalance * maxLeverage, computed by the screen. */
  maxNotional: number | null;
  /** availableBalance text for the quote row. */
  availableBalanceText: string | null;
  address: string | null;
  signMessage: PacificaSignMessage | null;
  /** Screen state hook: positions + balance refresh after an order. */
  refresh: () => void;
  /** Test seams: real signed-API calls by default; tests inject fakes. */
  placeLimitOrder?: typeof placeLimitOrder;
  placeOrder?: typeof placeOrder;
  setTPSL?: typeof setTPSL;
}

function parsePositive(text: string): number | null {
  const value = Number.parseFloat(text.trim());
  return Number.isFinite(value) && value > 0 ? value : null;
}

function inlineTP(text: string) {
  const trimmed = text.trim();
  return trimmed ? { stopPrice: trimmed, limitPrice: trimmed } : undefined;
}

export function createPacificaActionAdapter(
  deps: PacificaActionDeps,
): ActionVenueAdapter<PacificaActionBody, void> {
  const submitLimit = deps.placeLimitOrder ?? placeLimitOrder;
  const submitMarket = deps.placeOrder ?? placeOrder;
  const submitTPSL = deps.setTPSL ?? setTPSL;

  return {
    venueId: 'pacifica',
    kind: 'perps',
    label: 'Pacifica',

    amountLabel: () => 'Amount',
    amountPrefix: () => '$',
    amountSuffix: () => null,

    confirm: (body) => ({
      label: body.side === 'long' ? 'Long' : 'Short',
      accent: body.side === 'long' ? 'pos' : 'neg',
    }),

    validate(body, context: ActionPanelContext<void>): ActionValidation | null {
      if (!deps.address || !deps.signMessage) {
        return { title: 'Connect a wallet to trade Pacifica.', detail: null };
      }
      const amount = context.amount.amountValue;
      if (amount === null || amount <= 0) {
        return { title: 'Enter a valid amount.', detail: null };
      }
      if (deps.maxNotional != null && amount > deps.maxNotional) {
        return {
          title: `Notional exceeds your max: $${formatActionAmount(deps.maxNotional)}.`,
          detail: null,
        };
      }
      if (body.orderType === 'limit' && parsePositive(body.limitPriceText) === null) {
        return { title: 'Enter a valid limit price.', detail: null };
      }
      if (body.tpPriceText.trim() && parsePositive(body.tpPriceText) === null) {
        return { title: 'Enter a valid take-profit price.', detail: null };
      }
      if (body.slPriceText.trim() && parsePositive(body.slPriceText) === null) {
        return { title: 'Enter a valid stop-loss price.', detail: null };
      }
      return null;
    },

    quote(_body) {
      return {
        rows: [
          {
            key: 'MAX NOTIONAL',
            value: deps.maxNotional != null ? `$${formatActionAmount(deps.maxNotional)}` : '—',
            tone: 'neutral',
          },
          {
            key: 'AVAILABLE',
            value: deps.availableBalanceText ?? '—',
            tone: 'dim',
          },
          { key: 'SLIPPAGE', value: '1%', tone: 'dim' },
        ],
        loading: false,
        unavailableReason: null,
      };
    },

    async submit(body, context: ActionPanelContext<void>) {
      if (!deps.address || !deps.signMessage) {
        return { status: 'rejected', message: 'Connect a wallet before placing a Pacifica order.' };
      }
      const amount = context.amount.amountValue;
      if (amount === null || amount <= 0) {
        return { status: 'rejected', message: 'Enter a valid amount.' };
      }
      const apiSide = body.side === 'long' ? 'bid' : 'ask';
      const builderCode = PACIFIC_BUILDER_CODE || undefined;
      const tpParam = inlineTP(body.tpPriceText);
      const slParam = inlineTP(body.slPriceText);

      if (body.orderType === 'limit') {
        const limitPrice = parsePositive(body.limitPriceText);
        if (limitPrice === null) {
          return { status: 'rejected', message: 'Enter a valid limit price.' };
        }
        await submitLimit(
          { symbol: deps.symbol, side: apiSide, price: limitPrice, amountUsdc: amount, builderCode },
          deps.address,
          deps.signMessage,
        );
      } else {
        // Market order — placeOrder wrapper does not take inline TP/SL, so
        // setTPSL runs after, exactly as the screen does today (C-04).
        await submitMarket(
          { symbol: deps.symbol, side: apiSide, amountUsdc: amount, slippage: '1', builderCode },
          deps.address,
          deps.signMessage,
        );

        if (tpParam || slParam) {
          try {
            await submitTPSL(
              { symbol: deps.symbol, side: apiSide, takeProfit: tpParam, stopLoss: slParam, builderCode },
              deps.address,
              deps.signMessage,
            );
          } catch {
            return {
              status: 'partial',
              message: 'Order placed — TP/SL failed, set it manually.',
              closeAfter: false,
            };
          }
        }
      }

      deps.refresh();
      return { status: 'submitted', message: 'Executed — see positions', closeAfter: true };
    },
  };
}
