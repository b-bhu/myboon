/**
 * Polymarket portfolio History tab model (#736), moved verbatim from
 * `polymarket.portfolio.tsx`: the visible-activity filter (redeem entries
 * deduped against closed positions) and the History row builder that merges
 * closed positions with account activity. Pure move — no behaviour change.
 */

import { truncateUsd } from '@/features/polymarket/formatPolymarketMoney';
import type { ActivityItem } from '@/features/polymarket/polymarket.api';
import type { PolymarketActivityItem } from '@/features/polymarket/polymarketActivityState';
import { activityCashValue, activityLabel, formatAge } from '@/features/portfolio/polymarket/polymarket.format';
import type { VenuePortfolioRow } from '@/features/portfolio/venue-portfolio.contract';

/**
 * The account activity the History tab shows: newest first, capped at 50,
 * with redeem entries whose position already appears closed dropped.
 */
export function getPolymarketVisibleActivity(
  activity: ActivityItem[],
  closedItems: PolymarketActivityItem[],
): ActivityItem[] {
  const sortedActivity = [...activity]
    .sort((left, right) => (right.timestamp ?? 0) - (left.timestamp ?? 0))
    .slice(0, 50);
  const closedConditionIds = new Set(
    closedItems.map((item) => item.conditionId?.toLowerCase()).filter((id): id is string => !!id),
  );
  return sortedActivity.filter((entry) => {
    const type = entry.type.trim().toLowerCase();
    return !(type.includes('redeem') && entry.conditionId && closedConditionIds.has(entry.conditionId.toLowerCase()));
  });
}

export interface PolymarketHistoryTabProps {
  closedItems: PolymarketActivityItem[];
  visibleActivity: ActivityItem[];
  onOpenMarket: (slug: string) => void;
}

export function buildPolymarketHistoryRows({
  closedItems,
  visibleActivity,
  onOpenMarket,
}: PolymarketHistoryTabProps): VenuePortfolioRow[] {
  return [
    ...closedItems.map((item) => {
      const slug = item.marketSlug;
      return ({
        key: item.id,
        title: item.status === 'closed_won' ? 'Position won' : 'Position settled',
        subtitle: `${item.marketTitle} · ${item.outcome}`,
        value: (item.status === 'closed_won' ? `+${truncateUsd(item.currentValue)}` : truncateUsd(item.pnl)),
        valueTone: (item.status === 'closed_won' ? 'pos' : 'neg') as 'pos' | 'neg',
        subValue: item.createdAt ? formatAge(item.createdAt) : undefined,
        onPress: slug ? (() => onOpenMarket(slug)) : undefined,
      });
    }),
    ...visibleActivity.map((entry, index) => {
      const cashValue = activityCashValue(entry);
      return {
        key: `${entry.slug}:${entry.timestamp}:${index}`,
        title: activityLabel(entry),
        subtitle: `${entry.title} · ${entry.outcome}`,
        value: truncateUsd(cashValue),
        valueTone: (cashValue > 0 ? 'pos' : cashValue < 0 ? 'neg' : undefined) as 'pos' | 'neg' | undefined,
        subValue: formatAge(entry.timestamp < 10_000_000_000 ? entry.timestamp * 1000 : entry.timestamp),
        onPress: entry.slug ? () => onOpenMarket(entry.slug) : undefined,
      };
    }),
  ];
}
