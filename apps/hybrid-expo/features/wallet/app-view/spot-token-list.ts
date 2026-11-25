/**
 * Spot app view — the pure token-row mapping (issue #844, design wallet.html
 * frame "8. App view > Spot · token list").
 *
 * Reads the `spot` slot of the wallet summary: one row per token above $1
 * (dust hidden), largest first, plus the header figures. `valueUsd` of the
 * slot is the chain's total. Plain module, no React: unit-tested with
 * tsx --test (spot-token-list.test.ts).
 */

import { NO_DATA } from '@/lib/format';
import type { WalletSummary } from '@myboon/shared/wallet-summary';
import { usd } from './phoenix-top';

/** Design `tv(t) >= 1`: tokens worth less than this are dust and hidden. */
export const SPOT_DUST_USD = 1;

export interface SpotTokenRow {
  mint: string;
  symbol: string;
  iconUrl: string | null;
  /** `usd` format, e.g. "$1,250.00". */
  value: string;
}

export interface SpotTokenList {
  /** "{n} tokens · dust hidden" */
  countLine: string;
  /** The chain's total in `usd` format, or NO_DATA when unknown. */
  total: string;
  rows: SpotTokenRow[];
}

/** Null while there is no spot data to show (no summary, or the slot has no tokens answer). */
export function spotTokenList(summary: WalletSummary | null): SpotTokenList | null {
  const slot = summary?.apps.spot;
  if (!slot || !slot.summary) return null;
  const rows = slot.summary.tokens
    .filter((token) => token.valueUsd !== null && token.valueUsd >= SPOT_DUST_USD)
    .sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0))
    .map((token) => ({
      mint: token.mint,
      symbol: token.symbol ?? token.mint.slice(0, 4),
      iconUrl: token.iconUrl,
      value: usd(token.valueUsd ?? 0),
    }));
  return {
    countLine: `${rows.length} ${rows.length === 1 ? 'token' : 'tokens'} · dust hidden`,
    total: slot.valueUsd === null ? NO_DATA : usd(slot.valueUsd),
    rows,
  };
}
