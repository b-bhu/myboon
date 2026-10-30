import { FEED_MOCKS, withMock } from './feed-mocks';
import type { WalletActivity, WalletLabel } from './wallet-activity.types';

/**
 * Pure wallet-activity view model for the smart-wallets slide, leaderboard
 * screen and wallet sheet (issue #499). Grouping, totals and ordering come
 * from the fetched swaps; per-wallet PnL / win rate / rank are deterministic
 * sample values that exist only while FEED mocks are enabled.
 *
 * No react imports: plain-node tests run this module directly.
 */

/** One wallet's grouped trades, newest trade first. */
export type WalletRow = {
  address: string;
  labels: WalletLabel[];
  trades: WalletActivity[];
  tradeCount: number;
  buyCount: number;
  sellCount: number;
  /** Sum of valueUsd across the trades; null values count as 0. */
  volumeUsd: number;
  last: WalletActivity;
};

export type WalletRankedRow = WalletRow & { rank: number };

/** Prototype-only wallet metrics (30d PnL, win rate) keyed by address. */
export type WalletSample = { pnlUsd: number; winRate: number };

export type MostBought = { symbol: string; netUsd: number; buyers: number; sellers: number };

export type SwapHref = {
  pathname: '/swap';
  params: { mode: 'buy'; token: string; caller: 'feed' };
};

const LABEL_ORDER: WalletLabel[] = ['kol', 'smart_trader'];
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const newestFirst = (a: WalletActivity, b: WalletActivity): number => {
  const delta = Date.parse(b.observedAt) - Date.parse(a.observedAt);
  if (delta !== 0) return delta;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/**
 * One row per walletAddress: label union (kol, then smart_trader), trades
 * sorted newest first (id breaks ties), value totals with nulls as 0. Rows
 * order by volume desc, then tradeCount desc, then address asc.
 */
export function groupByWallet(activities: WalletActivity[]): WalletRow[] {
  const tradesByAddress = new Map<string, WalletActivity[]>();
  const labelsByAddress = new Map<string, Set<WalletLabel>>();
  for (const activity of activities) {
    const trades = tradesByAddress.get(activity.walletAddress) ?? [];
    trades.push(activity);
    tradesByAddress.set(activity.walletAddress, trades);
    const labels = labelsByAddress.get(activity.walletAddress) ?? new Set<WalletLabel>();
    for (const label of activity.walletLabels) labels.add(label);
    labelsByAddress.set(activity.walletAddress, labels);
  }
  const rows: WalletRow[] = [];
  for (const [address, trades] of tradesByAddress) {
    const ordered = [...trades].sort(newestFirst);
    const labels = LABEL_ORDER.filter((label) => labelsByAddress.get(address)?.has(label));
    rows.push({
      address,
      labels,
      trades: ordered,
      tradeCount: ordered.length,
      buyCount: ordered.filter((item) => item.action === 'buy').length,
      sellCount: ordered.filter((item) => item.action === 'sell').length,
      volumeUsd: ordered.reduce((sum, item) => sum + (item.valueUsd ?? 0), 0),
      last: ordered[0]!,
    });
  }
  rows.sort((a, b) => {
    if (b.volumeUsd !== a.volumeUsd) return b.volumeUsd - a.volumeUsd;
    if (b.tradeCount !== a.tradeCount) return b.tradeCount - a.tradeCount;
    return a.address < b.address ? -1 : a.address > b.address ? 1 : 0;
  });
  return rows;
}

/** Display label set: 'KOL', 'Smart' or 'KOL · Smart' regardless of stored order. */
export function walletLabelText(labels: WalletLabel[]): string {
  if (labels.length === 0) return '';
  const has = (label: WalletLabel) => labels.includes(label);
  if (has('kol') && has('smart_trader')) return 'KOL · Smart';
  return has('kol') ? 'KOL' : has('smart_trader') ? 'Smart' : '';
}

/** 4 characters, an ellipsis, then the last 3 ('7xQp…3fA'). Too-short values pass through. */
export function shortAddress(address: string): string {
  return address.length < 8 ? address : `${address.slice(0, 4)}…${address.slice(-3)}`;
}

/** Leaderboard/table subline: 'KOL · 18 trades · last JUP'. */
export function walletSubline(row: WalletRow): string {
  const nouns = row.tradeCount === 1 ? 'trade' : 'trades';
  const label = walletLabelText(row.labels);
  const prefix = label ? `${label} · ` : '';
  return `${prefix}${row.tradeCount} ${nouns} · last ${row.last.tokenSymbol}`;
}

/**
 * Token with the highest buy-minus-sell value across all activities
 * (null values count as 0); buyers/sellers are distinct wallets. Ties break
 * by ascending tokenAddress; null when there is no positive net at all.
 */
export function mostBought(activities: WalletActivity[]): MostBought | null {
  const byToken = new Map<string, { symbol: string; netUsd: number; buyers: Set<string>; sellers: Set<string> }>();
  for (const activity of activities) {
    const entry = byToken.get(activity.tokenAddress)
      ?? { symbol: activity.tokenSymbol, netUsd: 0, buyers: new Set<string>(), sellers: new Set<string>() };
    if (activity.action === 'buy') {
      entry.netUsd += activity.valueUsd ?? 0;
      entry.buyers.add(activity.walletAddress);
    } else {
      entry.netUsd -= activity.valueUsd ?? 0;
      entry.sellers.add(activity.walletAddress);
    }
    byToken.set(activity.tokenAddress, entry);
  }
  let best: { address: string; entry: { symbol: string; netUsd: number; buyers: Set<string>; sellers: Set<string> } } | null = null;
  for (const [address, entry] of byToken) {
    if (entry.netUsd <= 0) continue;
    if (best === null
      || entry.netUsd > best.entry.netUsd
      || (entry.netUsd === best.entry.netUsd && address < best.address)) {
      best = { address, entry };
    }
  }
  if (!best) return null;
  return { symbol: best.entry.symbol, netUsd: best.entry.netUsd, buyers: best.entry.buyers.size, sellers: best.entry.sellers.size };
}

// U+2212 minus, matching the design's signed amounts ('−$15.0K').
const MINUS = '\u2212';

/** '$84.2K' magnitude: one decimal under 100 units, none from 100 up, nearest rounding. */
function magnitude(abs: number, scale: number, suffix: 'K' | 'M' | 'B', escalation: { scale: number; suffix: 'K' | 'M' | 'B' } | null): string {
  const unit = abs / scale;
  const decimals = unit < 100 ? 1 : 0;
  const rounded = Math.round(unit * 10 ** decimals) / 10 ** decimals;
  // A 0-decimal round-up crossing into the next unit reads better in it
  // (999_999 → '+$1.0M', never '+$1000K').
  if (rounded >= 1000 && escalation) {
    return magnitude(abs, escalation.scale, escalation.suffix, escalation.suffix === 'M' ? { scale: 1e9, suffix: 'B' } : null);
  }
  return `${rounded.toFixed(decimals)}${suffix}`;
}

/** Signed compact dollars: '+$118K' / '\u2212$15.0K' / '$0'; '' when not finite. */
export function signedUsd(value: number): string {
  if (!Number.isFinite(value)) return '';
  if (value === 0) return '$0';
  const sign = value > 0 ? '+' : MINUS;
  const abs = Math.abs(value);
  const compact = abs < 1_000
    ? `${Math.round(abs)}`
    : abs < 1e6
      ? magnitude(abs, 1e3, 'K', { scale: 1e6, suffix: 'M' })
      : abs < 1e9
        ? magnitude(abs, 1e6, 'M', { scale: 1e9, suffix: 'B' })
        : magnitude(abs, 1e9, 'B', null);
  return `${sign}$${compact}`;
}

/** Signed value with direction: buys positive, sells negative, null blank. */
export function tradeValueSigned(activity: WalletActivity): string {
  if (activity.valueUsd === null) return '';
  return signedUsd(activity.action === 'buy' ? activity.valueUsd : -activity.valueUsd);
}

/** Short age on rows: 'just now' / '12m' / '2h' / '3d'; '' when unparseable. */
export function timeAgo(iso: string, now: Date = new Date()): string {
  const stamp = Date.parse(iso);
  if (Number.isNaN(stamp)) return '';
  const elapsed = now.getTime() - stamp;
  if (elapsed < MINUTE_MS) return 'just now';
  const minutes = Math.floor(elapsed / MINUTE_MS);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(elapsed / HOUR_MS);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(elapsed / DAY_MS)}d`;
}

/** Long age for sheet headers: '12m ago' / '2h ago' / '3d ago'; 'just now' stays bare. */
export function timeAgoLong(iso: string, now: Date = new Date()): string {
  const base = timeAgo(iso, now);
  if (!base || base === 'just now') return base;
  return `${base} ago`;
}

/**
 * Sample wallet store: one deterministic entry per address, filled lazily so
 * every call for the same wallet returns the same object identity.
 */
export const WALLET_SAMPLE = new Map<string, WalletSample>();

// Sample ranges keep the leaderboard plausible against the mock (+$412K top).
const PNL_LOW = -400_000;
const PNL_HIGH = 480_000;
const PNL_STEP = 1_000;
const WIN_MIN = 20;
const WIN_SPAN = 66;

const hash = (address: string, seed: number): number => {
  let value = seed | 0;
  for (let index = 0; index < address.length; index += 1) {
    value = (Math.imul(value, 31) + address.charCodeAt(index)) | 0;
  }
  return value < 0 ? -value : value;
};

function deriveSample(address: string): WalletSample {
  const pnlRatio = hash(address, 0x4b5f) / 2 ** 31;
  const pnlUsd = Math.round((PNL_LOW + (PNL_HIGH - PNL_LOW) * pnlRatio) / PNL_STEP) * PNL_STEP;
  const winRate = WIN_MIN + (hash(address, 0x77c9) % WIN_SPAN);
  return { pnlUsd, winRate };
}

/** Sample 30d PnL and win rate for an address, same values every call; null when mocks are off. */
export function walletSample(address: string, enabled?: boolean): WalletSample | null {
  if (withMock(true, enabled) !== true) return null;
  const cached = WALLET_SAMPLE.get(address);
  if (cached) return cached;
  const sample = deriveSample(address);
  WALLET_SAMPLE.set(address, sample);
  return sample;
}

/** Mocks on → ranked by sample PnL desc; mocks off → grouping order kept. Rank is always 1-based. */
export function rankRows(rows: WalletRow[], enabled?: boolean): WalletRankedRow[] {
  const mocksOn = enabled ?? FEED_MOCKS;
  const ordered = mocksOn
    ? [...rows].sort((a, b) => (walletSample(b.address, enabled)?.pnlUsd ?? -Infinity) - (walletSample(a.address, enabled)?.pnlUsd ?? -Infinity))
    : rows;
  return ordered.map((row, index) => ({ ...row, rank: index + 1 }));
}

/** Swap CTA target for a feed trade, same shape SpotScreen uses (caller marks the feed). */
export function swapHref(activity: WalletActivity): SwapHref {
  return { pathname: '/swap', params: { mode: 'buy', token: activity.tokenAddress, caller: 'feed' } };
}