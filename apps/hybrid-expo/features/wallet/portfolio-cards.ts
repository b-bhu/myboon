/**
 * Pure helpers for the Portfolio Cards view (issue #842, wallet.html at
 * 02b98eba, frame "Portfolio · Cards": a small P&L chip under the value).
 *
 * The chip reads the summary's own total: Polymarket `totalPnlUsd`, Phoenix
 * and Pacifica `unrealizedPnlUsd`, Meteora `totalPnlUsd`. Spot has none, and
 * an unknown (null) P&L shows no chip rather than a placeholder.
 */

import type { WalletSummary } from '@myboon/shared/wallet-summary';

import { formatPnlUsd, type PortfolioAppKey } from './wallet-portfolio.rows';

/** The app's P&L from a live summary; null when it has none or is not ok. */
export function portfolioCardPnl(summary: WalletSummary, key: PortfolioAppKey): number | null {
  const { apps } = summary;
  if (apps[key].status !== 'ok') return null;
  switch (key) {
    case 'polymarket':
      return apps.polymarket.summary?.totalPnlUsd ?? null;
    case 'meteora':
      return apps.meteora.summary?.totalPnlUsd ?? null;
    case 'phoenix':
      return apps.phoenix.summary?.unrealizedPnlUsd ?? null;
    case 'pacifica':
      return apps.pacifica.summary?.unrealizedPnlUsd ?? null;
  }
}

/** "+$18.00" / "-$6.00"; null (no P&L) gives no chip text. */
export function pnlChipText(pnlUsd: number | null): string | null {
  return pnlUsd === null ? null : formatPnlUsd(pnlUsd);
}
