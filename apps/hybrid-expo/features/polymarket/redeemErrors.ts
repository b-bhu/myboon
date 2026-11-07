import type { PortfolioPosition } from '@/features/polymarket/polymarket.api';
import type { PolymarketActivityItem } from '@/features/polymarket/polymarketActivityState';

const NO_REDEEMABLE_BALANCE_PATTERNS = [
  'no redeemable position balance',
  'no position balance found',
  'pusd or usdc.e collateral token ids',
];

function errorDetail(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    if (typeof record.detail === 'string') return record.detail;
    if (typeof record.error === 'string') return record.error;
    if (typeof record.message === 'string') return record.message;
  }
  return 'Unknown redeem error';
}

export function formatRedeemError(error: unknown): string {
  const detail = errorDetail(error).toLowerCase();
  if (NO_REDEEMABLE_BALANCE_PATTERNS.some((pattern) => detail.includes(pattern))) {
    return 'Nothing is redeemable for this pick yet. Refresh and try again.';
  }
  return 'Could not redeem this payout. Try again in a moment.';
}

export function logRedeemError(
  source: string,
  error: unknown,
  item?: PolymarketActivityItem | PortfolioPosition | null,
) {
  const record = item && typeof item === 'object' ? item as unknown as Record<string, unknown> : {};
  console.warn('[polymarket] Redeem failed', {
    source,
    detail: errorDetail(error),
    conditionId: typeof record.conditionId === 'string' ? record.conditionId : null,
    asset: typeof record.asset === 'string' ? record.asset : null,
    outcomeIndex: typeof record.outcomeIndex === 'number' ? record.outcomeIndex : null,
    slug: typeof record.marketSlug === 'string'
      ? record.marketSlug
      : typeof record.slug === 'string'
        ? record.slug
        : null,
  });
}
