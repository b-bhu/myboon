/**
 * Phoenix app view — top-block display figures (issue #848, design wallet.html
 * frame "Phoenix · Positions", "Top block" / AppStats).
 *
 * Reads the Phoenix slot off the wallet summary (#744) and returns the two
 * display strings the top block shows:
 *
 * - "Balance"        ← summary.apps.phoenix.valueUsd (equity)
 * - "Cash available" ← summary.apps.phoenix.summary.collateralUsd, as served
 *
 * Money format follows the design helpers exactly: `usd` = '$' + en-US money
 * at 2 decimals ("$1,250.00"), the same format meteora-top.ts uses. A `null`
 * value is unknown, not zero, and shows the one no-data glyph NO_DATA
 * (lib/format.ts).
 *
 * Plain module: no React, no fetch — unit-tested with tsx --test
 * (phoenix-top.test.ts). The `usd` formatter stays exported here for the
 * Positions tab (#849).
 */

import { NO_DATA } from '@/lib/format';
import type { WalletSummary } from '@myboon/shared/wallet-summary';
import type { PerpVenue } from './perp-positions';

export interface PhoenixTopFigures {
  /** "Balance" cell. */
  balance: string;
  /** "Cash available" cell. */
  cashAvailable: string;
}

/** Design `usd`: '$' + en-US money, 2 decimals, grouped ("$1,250.00"). */
export function usd(value: number): string {
  return (
    '$' +
    Math.abs(value).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

/**
 * The two top-block display strings. Returns null only when there is no
 * summary at all (the caller shows a skeleton or the failure banner then);
 * a Phoenix slot without figures carries NO_DATA cells instead.
 */
export function phoenixTopFigures(
  summary: WalletSummary | null,
  venue: PerpVenue = 'phoenix',
): PhoenixTopFigures | null {
  // Pacifica reuses the view (#857): same two cells, "Cash available" is
  // the slot's availableToSpendUsd instead of collateralUsd.
  const slot = venue === 'pacifica' ? summary?.apps.pacifica : summary?.apps.phoenix;
  if (!slot) return null;
  const cash =
    venue === 'pacifica'
      ? summary?.apps.pacifica.summary?.availableToSpendUsd ?? null
      : summary?.apps.phoenix.summary?.collateralUsd ?? null;
  return {
    balance: slot.valueUsd === null ? NO_DATA : usd(slot.valueUsd),
    cashAvailable: cash === null ? NO_DATA : usd(cash),
  };
}
