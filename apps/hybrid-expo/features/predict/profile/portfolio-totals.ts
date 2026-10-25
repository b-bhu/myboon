import type { PortfolioData } from '@/features/predict/predict.api';

/** Merged open + redeemable list cap applied by the portfolio API (#445). */
export const HELD_POSITIONS_CAP = 100;

export const APPROX_TOTAL_NOTE = 'Approximate: very large wallet';

type TotalsSummary = Pick<PortfolioData['summary'], 'totalsPartial' | 'totalPositionCount'>;

/** "Showing 100 of 2,628+" above the cap, otherwise null. */
export function formatShowingLabel(summary: TotalsSummary | null | undefined): string | null {
  if (!summary || summary.totalPositionCount <= HELD_POSITIONS_CAP) return null;
  const count = summary.totalPositionCount.toLocaleString('en-US');
  return `Showing ${HELD_POSITIONS_CAP} of ${count}${summary.totalsPartial ? '+' : ''}`;
}

/** Prefixes "≈ " to an already formatted total when the totals are lower bounds. */
export function formatApproxTotal(formatted: string, summary: TotalsSummary | null | undefined): string {
  return summary?.totalsPartial && formatted !== '--' ? `≈ ${formatted}` : formatted;
}
