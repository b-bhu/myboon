/**
 * Phoenix body for the shared action panel — PURE core.
 *
 * Ports the submit path of PhoenixMarketDetailScreen verbatim — same
 * placePhoenixOrder call, same base-amount conversion, same 50 bps slippage,
 * same readiness gate. No execution-module change. Everything here is
 * node-safe by design (no react-native) so the colocated test can import it;
 * the .tsx sibling is the thin UI shim.
 */

import type {
  PhoenixExecutionContext,
  PhoenixWalletSnapshot,
} from '@/features/perps/phoenix.execution';
import {
  getPhoenixExecutionReadiness,
  placePhoenixOrder,
} from '@/features/perps/phoenix.execution';
import type {
  ActionPanelContext,
  ActionVenueAdapter,
  ActionValidation,
} from '@/features/markets/action/action.contract';
import { formatActionAmount } from '@/features/markets/action/action.contract';

export interface PhoenixActionBody {
  side: 'long' | 'short';
  orderType: 'market' | 'limit';
  amountMode: 'usd' | 'base';
  limitPriceText: string;
}

export interface PhoenixActionDeps {
  connected: boolean;
  address: string | null;
  /** Wallet snapshot source — exactly what the screen wallet reports. */
  source: PhoenixWalletSnapshot['source'];
  isPreparing: boolean;
  /** Screen's bridged signer (phoenixSignAndSendTransaction) — returns the signature string. */
  signAndSendTransaction: NonNullable<PhoenixExecutionContext['signAndSendTransaction']> | null;
  connection: PhoenixExecutionContext['connection'];
  /** Marked-market price used for USD ↔ base conversion. */
  displayedPrice: number | null;
  /** Phoenix venue symbol of the open market, e.g. 'SOL-PERP'. */
  venueSymbol: string | null;
  /** Screen state hook: record a pending placement (screen owns the record shape). */
  onPendingPlacement: (placement: {
    side: 'long' | 'short';
    orderType: 'market' | 'limit';
    amountBase: number;
    amountUsdc: number;
    txSignature: string | null;
  }) => void;
  /** Screen state hook: positions/balance refresh. */
  refresh: () => void;
  /** Test seam: the real submit path by default; tests inject a fake. */
  placeOrder?: typeof placePhoenixOrder;
}

type PhoenixOrderResult = Awaited<ReturnType<typeof placePhoenixOrder>>;

function shortKey(signature: string): string {
  return `${signature.slice(0, 8)}…`;
}

export function createPhoenixActionAdapter(
  deps: PhoenixActionDeps,
): ActionVenueAdapter<PhoenixActionBody, void> {
  const submit = deps.placeOrder ?? placePhoenixOrder;
  const readiness = getPhoenixExecutionReadiness({
    connected: deps.connected,
    address: deps.address,
    source: deps.source,
    isPreparing: deps.isPreparing,
    signAndSendTransaction: deps.signAndSendTransaction,
  });

  function resolveBaseAmount(body: PhoenixActionBody, amountValue: number | null) {
    if (amountValue === null || !deps.displayedPrice || deps.displayedPrice <= 0) return null;
    return body.amountMode === 'base' ? amountValue : amountValue / deps.displayedPrice;
  }

  return {
    venueId: 'phoenix',
    kind: 'perps',
    label: 'Phoenix',

    amountLabel: () => 'Amount',
    amountPrefix: (body) => (body.amountMode === 'usd' ? '$' : null),
    amountSuffix: (body) => (body.amountMode === 'base' ? 'SOL' : null),

    confirm: (body) => ({
      label: body.side === 'long' ? 'Long' : 'Short',
      accent: body.side === 'long' ? 'pos' : 'neg',
    }),

    validate(body, context: ActionPanelContext<void>): ActionValidation | null {
      if (!deps.connected) {
        return { title: 'Connect a wallet to trade Phoenix.', detail: null };
      }
      if (!readiness.wallet?.canSignAndSendTransaction) {
        return {
          title: 'Wallet not ready — connect a Solana wallet that can sign.',
          detail: null,
        };
      }
      const amount = context.amount.amountValue;
      if (amount === null) {
        return { title: 'Enter an amount first.', detail: null };
      }
      const baseAmount = resolveBaseAmount(body, amount);
      if (baseAmount === null || baseAmount <= 0) {
        return { title: 'Enter a valid amount.', detail: null };
      }
      if (body.amountMode === 'usd') {
        const usdc = amount;
        const base = resolveBaseAmount(body, amount) ?? 0;
        const implied = base * (deps.displayedPrice ?? 0);
        if (!Number.isFinite(implied) || Math.abs(implied - usdc) > 1e-6) {
          return { title: 'Price unavailable — switch to base size.', detail: null };
        }
      }
      if (body.orderType === 'limit') {
        const limitPrice = Number.parseFloat(body.limitPriceText.trim());
        if (!Number.isFinite(limitPrice) || limitPrice <= 0) {
          return { title: 'Enter a valid limit price.', detail: null };
        }
      }
      return null;
    },

    quote(body, context) {
      const amount = context.amount.amountValue;
      const baseAmount = resolveBaseAmount(body, amount);
      return {
        rows: [
          {
            key: 'EST. PRICE',
            value: deps.displayedPrice ? `$${deps.displayedPrice.toFixed(4)}` : '—',
            tone: 'dim',
          },
          {
            key: 'EST. SIZE',
            value: baseAmount ? `${formatActionAmount(baseAmount, { maxDecimals: 8 })} SOL` : '—',
            tone: 'neutral',
          },
          { key: 'SLIPPAGE', value: '50 bps', tone: 'dim' },
        ],
        loading: false,
        unavailableReason: deps.displayedPrice ? null : 'Price unavailable',
      };
    },

    async submit(body, context) {
      const amount = context.amount.amountValue;
      const baseAmount = resolveBaseAmount(body, amount);
      if (!deps.address || !deps.venueSymbol) {
        return { status: 'rejected', message: 'Connect a wallet before placing a Phoenix order.' };
      }
      if (baseAmount === null || baseAmount <= 0) {
        return { status: 'rejected', message: 'Enter a valid amount.' };
      }
      if (body.orderType === 'limit') {
        const limitPrice = Number.parseFloat(body.limitPriceText.trim());
        if (!Number.isFinite(limitPrice) || limitPrice <= 0) {
          return { status: 'rejected', message: 'Enter a valid limit price.' };
        }
      }

      const contextForPhoenix = {
        wallet: readiness.wallet,
        connection: deps.connection,
        signAndSendTransaction: deps.signAndSendTransaction,
      };
      const result: PhoenixOrderResult = await submit(
        {
          venueId: 'phoenix',
          authority: deps.address,
          symbol: deps.venueSymbol,
          side: body.side,
          orderType: body.orderType,
          amountMode: 'base',
          amount: baseAmount.toFixed(8).replace(/\.?0+$/, ''),
          limitPrice: body.orderType === 'limit' ? body.limitPriceText.trim() : undefined,
          slippageBps: 50,
        },
        contextForPhoenix,
      );

      const message =
        result.error?.message ??
        (result.txSignature ? `Submitted: ${shortKey(result.txSignature)}` : 'Phoenix order submitted.');

      if (result.status !== 'submitted') {
        return { status: 'rejected', message };
      }
      if (result.txSignature) {
        deps.onPendingPlacement({
          side: body.side,
          orderType: body.orderType,
          amountBase: baseAmount,
          amountUsdc: deps.displayedPrice ? baseAmount * deps.displayedPrice : 0,
          txSignature: result.txSignature,
        });
        deps.refresh();
      }
      return { status: 'submitted', message, closeAfter: true };
    },
  };
}
