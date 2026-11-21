/**
 * Polymarket portfolio Positions tab model (#736), moved verbatim from
 * `polymarket.portfolio.tsx`: the Ready-to-collect (redeemable) and Open
 * positions row builders that feed the shared venue shell's positions tab.
 * A plain builder — the screen keeps the redeem, cash-out and sell-quote
 * hooks and passes their state in. Pure move — no behaviour change.
 */

import type { SecureClient } from '@polymarket/client';

import { truncateUsd } from '@/features/polymarket/formatPolymarketMoney';
import { formatPolymarketTitle } from '@/features/polymarket/formatPolymarketTitle';
import { getPositionSellQuote, type PositionSellQuoteMap } from '@/features/polymarket/positionSellQuotes';
import type { PortfolioPosition } from '@/features/polymarket/polymarket.api';
import { positionKey } from '@/features/portfolio/polymarket/polymarket.format';
import type { VenuePortfolioRow } from '@/features/portfolio/venue-portfolio.contract';

export interface PolymarketPositionsTabProps {
  redeemablePositions: PortfolioPosition[];
  positions: PortfolioPosition[];
  sellQuotes: PositionSellQuoteMap;
  redeemingId: string | null;
  redeemError: { id: string; message: string } | null;
  actionsDisabled: boolean;
  polyClient: SecureClient | null;
  onCollect: (position: PortfolioPosition) => Promise<void>;
  onCashOut: (position: PortfolioPosition) => void;
  onOpenMarket: (slug: string) => void;
}

export interface PolymarketPositionsTabRows {
  redeemableRows: VenuePortfolioRow[];
  positionRows: VenuePortfolioRow[];
}

export function buildPolymarketPositionsTab({
  redeemablePositions,
  positions,
  sellQuotes,
  redeemingId,
  redeemError,
  actionsDisabled,
  polyClient,
  onCollect,
  onCashOut,
  onOpenMarket,
}: PolymarketPositionsTabProps): PolymarketPositionsTabRows {
  const redeemableRows = redeemablePositions.map((position) => ({
    key: `ready:${positionKey(position)}`,
    title: formatPolymarketTitle({ title: position.title, slug: position.slug || position.eventSlug }),
    titleAccent: position.outcome,
    subtitle: redeemError?.id === positionKey(position) ? redeemError.message : 'Your winning position · redeem once the market settles',
    value: truncateUsd(position.currentValue),
    actionLabel:
      redeemingId === positionKey(position)
        ? 'Collecting…'
        : `Collect ${truncateUsd(position.currentValue)}`,
    actionPending: redeemingId === positionKey(position),
    actionDisabled: actionsDisabled || !polyClient,
    onActionPress: () => void onCollect(position),
    onPress: undefined,
  }));

  const positionRows = positions.map((position) => {
    const quote = getPositionSellQuote(sellQuotes, position);
    const pnl = quote?.cashPnl ?? null;
    const currentValue = quote?.estimatedProceeds ?? null;
    return {
      key: positionKey(position),
      title: formatPolymarketTitle({ title: position.title, slug: position.slug || position.eventSlug }),
      titleAccent: position.outcome,
      subtitle: `You paid ${truncateUsd(position.size * position.avgPrice)} · ${Number.isFinite(position.curPrice) ? `${Math.round(position.curPrice * 100)}%` : '--'} chance now`,
      value: currentValue !== null ? truncateUsd(currentValue) : '--',
      valueTone: (pnl !== null ? (pnl < 0 ? 'neg' : 'pos') : undefined) as 'pos' | 'neg' | undefined,
      subValue: pnl === null ? undefined : `${pnl >= 0 ? '+' : ''}${truncateUsd(pnl)}`,
      subValueTone: (pnl !== null ? (pnl < 0 ? 'neg' : 'pos') : undefined) as 'pos' | 'neg' | undefined,
      actionLabel: quote?.loading ? 'Checking…' : 'Cash out',
      actionDisabled: Boolean(quote?.loading) || actionsDisabled,
      onActionPress: () => onCashOut(position),
      onPress: position.slug ? () => onOpenMarket(position.slug) : undefined,
    };
  });

  return { redeemableRows, positionRows };
}
