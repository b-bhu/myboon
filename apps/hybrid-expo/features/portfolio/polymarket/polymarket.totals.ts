/**
 * Pure totals derivation of the Polymarket portfolio screen (#733), moved
 * verbatim from `polymarket.portfolio.tsx`: the projections the screen renders
 * — the snapshot's positions lists and API summary totals plus the
 * account-state labels. A plain function, not a hook: the sell-quote and
 * redeem state hooks stay in the screen. Pure move — no behaviour change.
 */

import type { OpenOrder, PortfolioData } from '@/features/polymarket/polymarket.api';
import type { PolymarketProfileAccountState } from '@/features/polymarket/portfolio/profile-state';
import { formatShowingLabel, resolveCashOutNow } from '@/features/polymarket/portfolio/portfolio-totals';
import { EMPTY_PORTFOLIO_POSITIONS, getOrderCost } from './polymarket.format';

export interface PolymarketPortfolioTotalsInput {
  portfolio: PortfolioData | null;
  openOrders: OpenOrder[];
  cashBalance: number | null;
  accountState: PolymarketProfileAccountState;
}

export interface PolymarketPortfolioTotals {
  positions: PortfolioData['positions'];
  redeemablePositions: PortfolioData['redeemablePositions'];
  closedPositions: PortfolioData['closedPositions'];
  portfolioSummary: PortfolioData['summary'] | null;
  cashOutNow: number | null;
  showingLabel: string | null;
  readyToCollect: number;
  waitingPickValue: number;
  activePicksValue: number | null;
  polymarketValue: number | null;
  portfolioVisible: boolean;
  accountStateLabel: string;
  accountStatePositive: boolean;
  actionsDisabled: boolean;
}

export function derivePolymarketTotals(input: PolymarketPortfolioTotalsInput): PolymarketPortfolioTotals {
  const { portfolio, openOrders, cashBalance, accountState } = input;
  const positions = portfolio?.positions ?? EMPTY_PORTFOLIO_POSITIONS;
  const redeemablePositions = portfolio?.redeemablePositions ?? [];
  const closedPositions = portfolio?.closedPositions ?? [];
  // #447: totals come from the API summary (every page, up to the ceiling),
  // never re-summed over the capped list.
  const portfolioSummary = portfolio?.summary ?? null;
  const cashOutNow = resolveCashOutNow(portfolio);
  const showingLabel = formatShowingLabel(portfolioSummary);
  const readyToCollect = portfolio?.summary.readyToCollect ?? redeemablePositions.reduce((sum, p) => sum + (p.currentValue ?? 0), 0);
  const waitingPickValue = openOrders.reduce((sum, order) => sum + getOrderCost(order), 0);
  const activePicksValue = cashOutNow === null ? null : cashOutNow + waitingPickValue;
  const polymarketValue = cashBalance === null || activePicksValue === null
    ? null
    : cashBalance + activePicksValue + readyToCollect;
  const portfolioVisible = accountState === 'ready' || accountState === 'session_expired';
  const accountStateLabel = accountState === 'ready'
    ? 'Account protected'
    : accountState === 'session_expired'
      ? 'Reconnect needed'
      : accountState === 'preparing'
        ? 'Checking account'
        : accountState === 'signed_out'
          ? 'Not connected'
          : accountState === 'unsupported'
            ? 'Wallet unsupported'
            : 'Setup needed';
  const accountStatePositive = accountState === 'ready';

  const actionsDisabled = accountState !== 'ready';

  return {
    positions,
    redeemablePositions,
    closedPositions,
    portfolioSummary,
    cashOutNow,
    showingLabel,
    readyToCollect,
    waitingPickValue,
    activePicksValue,
    polymarketValue,
    portfolioVisible,
    accountStateLabel,
    accountStatePositive,
    actionsDisabled,
  };
}
