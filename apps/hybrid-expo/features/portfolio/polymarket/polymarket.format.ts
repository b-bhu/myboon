/**
 * Private helpers of the Polymarket portfolio screen (#733), moved verbatim
 * from `polymarket.portfolio.tsx`: address/email masking, the profile
 * currency formatter with its USD→INR rate fetcher, order costs, activity
 * labels and ages, position keys and the stable empty-positions constant.
 * Pure move — no behaviour change.
 */

import { truncateUsd } from '@/features/polymarket/formatPolymarketMoney';
import type { ActivityItem, OpenOrder, PortfolioPosition } from '@/features/polymarket/polymarket.api';
import { remainingOrderCost } from '@/features/polymarket/portfolio/profile-portfolio-state';

export function truncate(addr: string, start = 6, end = 4): string {
  return `${addr.slice(0, start)}···${addr.slice(-end)}`;
}

export function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const [local, domain] = email.split('@');
  if (!local || !domain) return null;
  return `${local.slice(0, Math.min(2, local.length))}•••@${domain}`;
}

export const POLYMARKET_PROFILE_FALLBACK_USD_TO_INR = 95.67;
const USD_INR_RATE_URL = 'https://open.er-api.com/v6/latest/USD';
export const POLYMARKET_PROFILE_CURRENCY_KEY = 'predict-profile-currency-format';
export type PolymarketProfileCurrency = 'USD' | 'INR';
export type PolymarketSettingsView = 'menu' | 'currency' | 'wallet' | 'security' | 'odds' | 'amounts' | 'signout';
export type ConnectionIntent = 'polymarket' | 'withdrawal' | null;
export const EMPTY_PORTFOLIO_POSITIONS: PortfolioPosition[] = [];

export function formatProfileCurrency(
  value: number | null | undefined,
  currency: PolymarketProfileCurrency,
  usdToInr = POLYMARKET_PROFILE_FALLBACK_USD_TO_INR,
): string {
  if (currency === 'USD') return truncateUsd(value);
  if (value == null || !Number.isFinite(value)) return '--';
  const inr = Math.abs(value * usdToInr);
  const prefix = value < 0 ? '-' : '';
  if (inr >= 100000) return `${prefix}₹${(inr / 100000).toFixed(1)}L`;
  if (inr >= 1000) return `${prefix}₹${(inr / 1000).toFixed(1)}K`;
  return `${prefix}₹${inr.toFixed(0)}`;
}

export async function fetchUsdToInrRate(): Promise<number | null> {
  try {
    const response = await fetch(USD_INR_RATE_URL);
    if (!response.ok) return null;
    const data = await response.json();
    const rate = Number(data?.rates?.INR);
    return Number.isFinite(rate) && rate > 0 ? rate : null;
  } catch {
    return null;
  }
}

export function getOrderCost(order: OpenOrder): number {
  return remainingOrderCost(order) ?? 0;
}

export function orderCost(order: OpenOrder): number | null {
  return remainingOrderCost(order);
}

export function formatAge(value: number): string {
  const createdMs = value < 10_000_000_000 ? value * 1000 : value;
  const age = Date.now() - createdMs;
  if (!Number.isFinite(age) || age < 0) return '';
  const minutes = Math.floor(age / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function positionKey(position: PortfolioPosition): string {
  return `${position.conditionId}:${position.outcomeIndex}:${position.asset}`;
}

export function activityLabel(entry: ActivityItem): string {
  const type = entry.type.trim().toLowerCase();
  if (type.includes('redeem')) return 'Payout collected';
  if (type.includes('trade')) return entry.side.toLowerCase() === 'sell' ? 'Position sold' : 'Position bought';
  if (type.includes('split')) return 'Position prepared';
  if (type.includes('merge')) return 'Position settled';
  return entry.type.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function activityCashValue(entry: ActivityItem): number {
  const value = Math.abs(entry.usdcSize);
  const type = entry.type.trim().toLowerCase();
  if (type.includes('redeem') || type.includes('merge')) return value;
  if (type.includes('split')) return -value;
  if (type.includes('trade')) return entry.side.trim().toLowerCase() === 'sell' ? value : -value;
  return entry.usdcSize;
}
