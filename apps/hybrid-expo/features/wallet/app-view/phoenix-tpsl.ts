/**
 * Phoenix Edit TP/SL sheet — pure helpers (issue #851, design wallet.html
 * frame "Phoenix · TP/SL sheet").
 *
 * - `pnlAtPrice`: the P&L line under a field, `(price - entry) * size`,
 *   flipped for a short; null while the field is empty or not a positive
 *   number, or when the entry is unknown.
 * - `validateTpsl`: the two field texts in, the two prices to send (as typed,
 *   trimmed) or the validation message out. A cleared field leaves that
 *   trigger as it is (no removal is drawn).
 *
 * Plain module for tsx --test (phoenix-tpsl.test.ts).
 */

import type { WalletPerpPositionDetail } from '@myboon/shared/wallet-summary';

export const TPSL_EMPTY_MESSAGE = 'Enter a take profit or stop loss price.';
export const TPSL_INVALID_MESSAGE = 'TP/SL prices must be greater than zero.';

/** A field's price: the number, null when empty, NaN when not a positive number. */
function parsePrice(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value > 0 ? value : Number.NaN;
}

/** P&L if the position closes at `priceText`; null when there is nothing to show. */
export function pnlAtPrice(
  position: Pick<WalletPerpPositionDetail, 'side' | 'size' | 'entryPriceUsd'>,
  priceText: string,
): number | null {
  const price = parsePrice(priceText);
  if (price === null || Number.isNaN(price) || position.entryPriceUsd === null) return null;
  const pnl = (price - position.entryPriceUsd) * position.size;
  return position.side === 'short' ? -pnl : pnl;
}

export type TpslValidation =
  | { ok: true; takeProfit: string | null; stopLoss: string | null }
  | { ok: false; message: string };

export function validateTpsl(tpText: string, slText: string): TpslValidation {
  const tp = parsePrice(tpText);
  const sl = parsePrice(slText);
  if (tp === null && sl === null) return { ok: false, message: TPSL_EMPTY_MESSAGE };
  if ((tp !== null && Number.isNaN(tp)) || (sl !== null && Number.isNaN(sl))) {
    return { ok: false, message: TPSL_INVALID_MESSAGE };
  }
  return {
    ok: true,
    takeProfit: tp === null ? null : tpText.trim(),
    stopLoss: sl === null ? null : slText.trim(),
  };
}

/** A field's starting text: the current price, empty when there is none. */
export function prefill(price: number | null): string {
  return price === null ? '' : String(price);
}
