/**
 * Phoenix Positions tab — card display strings (issue #849, design
 * wallet.html frame "Phoenix · Positions", component ".pc[data-t=perp]").
 *
 * Pure: one position in, the strings its card shows out. A null number is
 * unknown, not zero, and shows NO_DATA. Plain module for tsx --test
 * (phoenix-positions.test.ts).
 */

import { NO_DATA } from '@/lib/format';
import type { WalletPerpPositionDetail } from '@myboon/shared/wallet-summary';
import type { PerpVenue } from './perp-positions';
import { usd } from './phoenix-top';

export interface PerpCardFigures {
  /** Card title: the market symbol ("SOL-PERP"). */
  title: string;
  /** "Long 5×" / "Short 3×"; just "Long" / "Short" without leverage. */
  tag: string;
  /** "1.24 SOL". */
  size: string;
  /** Right column, top: money or NO_DATA. */
  value: string;
  /** "+$11.43 · +29.3%"; each half is NO_DATA when unknown. */
  pnl: string;
  /** Sign of the P&L for colour; null when unknown. */
  pnlTone: 'up' | 'down' | null;
  entry: string;
  mark: string;
  liq: string;
  /** "TP 175.00 · SL 140.00"; "not set" for a null price. Null for Pacifica (no TP/SL data, #857). */
  tpsl: string | null;
  /** Where "Close position" goes. */
  marketHref: string;
}

/** Price cell: thousands grouping, two decimals, no currency sign. */
export function perpPrice(value: number | null): string {
  if (value === null) return NO_DATA;
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function signedUsd(value: number): string {
  return (value < 0 ? '−' : '+') + usd(value);
}

function signedPct(value: number): string {
  return (value < 0 ? '−' : '+') + Math.abs(value).toFixed(1) + '%';
}

export function perpTag(side: 'long' | 'short', leverage: number | null): string {
  const label = side === 'long' ? 'Long' : 'Short';
  return leverage === null ? label : `${label} ${leverage}×`;
}

export function perpCardFigures(
  position: WalletPerpPositionDetail,
  venue: PerpVenue = 'phoenix',
): PerpCardFigures {
  const base = position.symbol.replace(/-PERP$/, '');
  const size = position.size.toLocaleString('en-US', { maximumFractionDigits: 6 });
  const pnlUsd = position.unrealizedPnlUsd;
  const pnlPct = position.pnlPct;
  const tp = position.takeProfitPriceUsd === null ? 'not set' : perpPrice(position.takeProfitPriceUsd);
  const sl = position.stopLossPriceUsd === null ? 'not set' : perpPrice(position.stopLossPriceUsd);
  return {
    title: position.symbol,
    tag: perpTag(position.side, position.leverage),
    size: `${size} ${base}`,
    value: position.valueUsd === null ? NO_DATA : usd(position.valueUsd),
    pnl: `${pnlUsd === null ? NO_DATA : signedUsd(pnlUsd)} · ${pnlPct === null ? NO_DATA : signedPct(pnlPct)}`,
    pnlTone: pnlUsd === null ? null : pnlUsd < 0 ? 'down' : 'up',
    entry: perpPrice(position.entryPriceUsd),
    mark: perpPrice(position.markPriceUsd),
    liq: perpPrice(position.liquidationPriceUsd),
    tpsl: venue === 'pacifica' ? null : `TP ${tp} · SL ${sl}`,
    marketHref: `/markets/${venue}/${position.symbol}`,
  };
}
