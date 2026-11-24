/**
 * Meteora app view — top-block display figures (issue #852, design wallet.html
 * frame "Meteora · Positions", "Top block" / AppStats).
 *
 * Reads the Meteora slot off the wallet summary (#766) and returns the three
 * display strings the top block shows:
 *
 * - "Pool value"     ← summary.apps.meteora.valueUsd
 * - "Unclaimed fees" ← summary.apps.meteora.summary.unclaimedFeesUsd
 * - "Total P&L"      ← summary.apps.meteora.summary.totalPnlUsd, signed
 *
 * Formats follow the design helpers exactly: `usd` = '$' + en-US money at 2
 * decimals ("$1,918.00"), and the signed P&L is the design's `sg` = sign +
 * that amount ("+$96.40", "−$5.96"; zero shows "+$0.00"). A `null` value is
 * unknown, not zero, and shows the one no-data glyph NO_DATA (lib/format.ts).
 *
 * Plain module: no React, no fetch — unit-tested with tsx --test
 * (meteora-top.test.ts).
 */

import { NO_DATA } from '@/lib/format';
import type { WalletSummary } from '@myboon/shared/wallet-summary';

export interface MeteoraTopFigures {
  /** "Pool value" cell. */
  poolValue: string;
  /** "Unclaimed fees" cell. */
  unclaimedFees: string;
  /** "Total P&L" cell, signed: "+$96.40", "−$5.96", "+$0.00". */
  totalPnl: string;
}

/** Design `usd`: '$' + en-US money, 2 decimals, grouped ("$1,918.00"). */
function usd(value: number): string {
  return (
    '$' +
    Math.abs(value).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

/** Design `sg` (the P&L cell): sign then `usd`, zero reads positive ("+$0.00"). */
function signedUsd(value: number): string {
  return (value < 0 ? '−' : '+') + usd(value);
}

/**
 * The three top-block display strings. Returns null only when there is no
 * summary at all (the caller shows a skeleton or the failure banner then);
 * a Meteora slot without figures carries NO_DATA cells instead.
 */
export function meteoraTopFigures(summary: WalletSummary | null): MeteoraTopFigures | null {
  const meteora = summary?.apps.meteora;
  if (!meteora) return null;
  const fees = meteora.summary?.unclaimedFeesUsd ?? null;
  const pnl = meteora.summary?.totalPnlUsd ?? null;
  return {
    poolValue: meteora.valueUsd === null ? NO_DATA : usd(meteora.valueUsd),
    unclaimedFees: fees === null ? NO_DATA : usd(fees),
    totalPnl: pnl === null ? NO_DATA : signedUsd(pnl),
  };
}
