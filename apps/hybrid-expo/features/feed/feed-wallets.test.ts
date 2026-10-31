import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WALLET_SAMPLE,
  groupByWallet,
  mostBought,
  rankRows,
  shortAddress,
  signedUsd,
  swapHref,
  timeAgo,
  timeAgoLong,
  tradeValueSigned,
  walletLabelText,
  walletSample,
  walletSubline,
  leaderboardRankLabel,
} from './feed-wallets';
import type { WalletActivity, WalletLabel } from './wallet-activity.types';
import type { WalletRow } from './feed-wallets';

// Fixed clock so relative ages are exact regardless of the host zone.
const NOW = new Date('2026-10-30T12:00:00Z');

/** observedAt `minutes` before NOW. */
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

const SIGNATURE = 'S'.repeat(70);
const JUP = { address: 'JUPmint1111111111111111111111111', symbol: 'JUP', name: 'Jupiter' };
const WIF = { address: 'WIFmint11111111111111111111111111', symbol: 'WIF', name: 'dogwifhat' };

const trade = (patch: Partial<WalletActivity> = {}): WalletActivity => ({
  id: 't1',
  walletAddress: '7xQpWWWWWWWWWWWWWWW3fA',
  walletLabels: ['smart_trader'],
  classificationToken: JUP,
  action: 'buy',
  tokenAddress: JUP.address,
  tokenSymbol: 'JUP',
  amount: 1_200_000,
  priceUsd: 0.7,
  valueUsd: 84_200,
  signature: SIGNATURE,
  observedAt: ago(10),
  ...patch,
});

const row = (address: string, trades: WalletActivity[]): WalletRow => ({
  address,
  labels: ['kol', 'smart_trader'],
  trades,
  tradeCount: trades.length,
  buyCount: trades.filter((item) => item.action === 'buy').length,
  sellCount: trades.filter((item) => item.action === 'sell').length,
  volumeUsd: trades.reduce((sum, item) => sum + (item.valueUsd ?? 0), 0),
  last: trades[0]!,
});

test('groupByWallet groups by walletAddress with counts and volume (nulls as 0)', () => {
  const rows = groupByWallet([
    trade({ id: 't2', valueUsd: null, observedAt: ago(5) }),
    trade({ id: 't1', valueUsd: 84_200, observedAt: ago(30) }),
    trade({ id: 't3', walletAddress: '9KdWWWWWWWWWWWWWWWe21', action: 'sell', valueUsd: 15_000 }),
  ]);
  assert.equal(rows.length, 2);
  const top = rows[0]!;
  assert.equal(top.address, '7xQpWWWWWWWWWWWWWWW3fA');
  assert.equal(top.tradeCount, 2);
  assert.equal(top.buyCount, 2);
  assert.equal(top.sellCount, 0);
  // valueUsd nulls contribute 0.
  assert.equal(top.volumeUsd, 84_200);
  // Newest trade first, so the last trade is the 5-minute-old one.
  assert.equal(top.last.id, 't2');
  assert.deepEqual(top.trades.map((item) => item.id), ['t2', 't1']);
  const second = rows[1]!;
  assert.equal(second.address, '9KdWWWWWWWWWWWWWWWe21');
  assert.equal(second.sellCount, 1);
  assert.equal(second.volumeUsd, 15_000);
});

test('groupByWallet sorts trades newest first and ties break by ascending id', () => {
  const rows = groupByWallet([
    trade({ id: 't2', observedAt: ago(20) }),
    trade({ id: 't1', observedAt: ago(20) }),
    trade({ id: 't4', observedAt: ago(1) }),
    trade({ id: 't3', observedAt: ago(1) }),
  ]);
  assert.deepEqual(rows[0]!.trades.map((item) => item.id), ['t3', 't4', 't1', 't2']);
});

test('groupByWallet unions labels in kol then smart_trader order', () => {
  const rows = groupByWallet([
    trade({ id: 't1', walletLabels: ['smart_trader'] }),
    trade({ id: 't2', walletLabels: ['smart_trader'] }),
    trade({ id: 't3', walletLabels: ['kol', 'smart_trader'], observedAt: ago(15) }),
  ]);
  const labels: WalletLabel[] = ['kol', 'smart_trader'];
  assert.deepEqual(rows[0]!.labels, labels);
});

test('groupByWallet orders rows by volume desc, then tradeCount desc, then address asc', () => {
  const rows = groupByWallet([
    // Low volume, many trades.
    trade({ id: 't11', walletAddress: 'aaa111', valueUsd: 1_000 }),
    trade({ id: 't12', walletAddress: 'aaa111', valueUsd: 1_000 }),
    trade({ id: 't13', walletAddress: 'aaa111', valueUsd: 1_000 }),
    // Higher volume, fewer trades.
    trade({ id: 't21', walletAddress: 'bbb222', valueUsd: 50_000 }),
    // Same volume as bbb, one trade: address tie goes up (aaa < bbb is taken,
    // ccc and bbb tie on volume+count, but bbb has one trade vs ccc one too).
    trade({ id: 't31', walletAddress: 'ccc333', valueUsd: 50_000 }),
    // Same volume and count as bbb → address asc puts bbb111 first, then bbb222.
    trade({ id: 't41', walletAddress: 'bbb111', valueUsd: 50_000 }),
    // Small volume, single trade.
    trade({ id: 't51', walletAddress: 'ddd444', valueUsd: 5_000 }),
    // Lowest volume: three trades of 1_000.
  ]);
  // bbb ties break by address asc; ddd444's 5_000 beats aaa111's 3_000.
  assert.deepEqual(
    rows.map((item) => item.address),
    ['bbb111', 'bbb222', 'ccc333', 'ddd444', 'aaa111'],
  );
});

test('groupByWallet returns no rows for empty activity', () => {
  assert.deepEqual(groupByWallet([]), []);
});

test('walletLabelText maps label sets to display text', () => {
  assert.equal(walletLabelText(['kol']), 'KOL');
  assert.equal(walletLabelText(['smart_trader']), 'Smart');
  assert.equal(walletLabelText(['kol', 'smart_trader']), 'KOL · Smart');
  // Order of the stored labels never changes the display order.
  assert.equal(walletLabelText(['smart_trader', 'kol']), 'KOL · Smart');
  assert.equal(walletLabelText([]), '');
});

test('shortAddress keeps first 4, last 3, and leaves tiny values alone', () => {
  assert.equal(shortAddress('7xQpWWWWWWWWWWWWWWW3fA'), '7xQp…3fA');
  assert.equal(shortAddress('abcdefg'), 'abcdefg');
  assert.equal(shortAddress(''), '');
});

test('walletSubline reads label text, trade count, last symbol', () => {
  const single = { ...row('aaa111', [trade({ tokenSymbol: 'WIF' })]), labels: ['kol'] as WalletLabel[] };
  assert.equal(walletSubline(single), 'KOL · 1 trade · last WIF');
  const many = { ...row('aaa111', [trade(), trade({ id: 't2', tokenSymbol: 'WIF', observedAt: ago(30) })]), labels: ['smart_trader'] as WalletLabel[] };
  assert.equal(walletSubline(many), 'Smart · 2 trades · last JUP');
});

test('mostBought picks the token with the highest net buy-minus-sell value', () => {
  const top = mostBought([
    trade({ id: 't1', walletAddress: 'walletA' }),
    trade({ id: 't2', walletAddress: 'walletB', valueUsd: 30_000 }),
    trade({ id: 't3', walletAddress: 'walletC', action: 'sell', valueUsd: 10_000 }),
    // WIF activity stays below JUP's net.
    trade({ id: 't4', tokenAddress: WIF.address, tokenSymbol: WIF.symbol, classificationToken: WIF, valueUsd: 12_000 }),
    trade({ id: 't5', tokenAddress: WIF.address, tokenSymbol: WIF.symbol, classificationToken: WIF, action: 'sell', valueUsd: 4_000 }),
  ]);
  assert.deepEqual(top, { symbol: 'JUP', netUsd: 104_200, buyers: 2, sellers: 1 });
});

test('mostBought counts null values as zero but counts their wallets as buyers', () => {
  const top = mostBought([
    trade({ id: 't1', valueUsd: null, walletAddress: 'walletNull' }),
    trade({ id: 't2', valueUsd: 5_000, walletAddress: 'walletA' }),
    trade({ id: 't3', walletAddress: 'walletNull', action: 'sell', valueUsd: 2_000 }),
  ]);
  assert.deepEqual(top, { symbol: 'JUP', netUsd: 3_000, buyers: 2, sellers: 1 });
});

test('mostBought returns null for no activity and for tokens without positive net', () => {
  assert.equal(mostBought([]), null);
  assert.equal(mostBought([trade({ action: 'buy', valueUsd: 5_000 }), trade({ action: 'sell', valueUsd: 15_000 })]), null);
  assert.equal(mostBought([trade({ action: 'sell', valueUsd: 1_000 })]), null);
});

test('mostBought breaks net ties deterministically by token address', () => {
  const top = mostBought([
    trade({ valueUsd: 10_000 }),
    trade({ tokenAddress: WIF.address, tokenSymbol: WIF.symbol, classificationToken: WIF, valueUsd: 10_000 }),
  ]);
  // 'JUPmint…' < 'WIFmint…' lexicographically.
  assert.equal(top?.symbol, 'JUP');
});

test('signedUsd formats compact signed dollar amounts', () => {
  assert.equal(signedUsd(0), '$0');
  assert.equal(signedUsd(118_000), '+$118K');
  assert.equal(signedUsd(84_200), '+$84.2K');
  assert.equal(signedUsd(412_000), '+$412K');
  assert.equal(signedUsd(15_000), '+$15.0K');
  assert.equal(signedUsd(1_250_000), '+$1.3M');
  // U+2212 minus for negatives.
  assert.equal(signedUsd(-15_000), '\u2212$15.0K');
  assert.equal(signedUsd(-84_200), '\u2212$84.2K');
  assert.equal(signedUsd(-1_250_000), '\u2212$1.3M');
});

test('signedUsd keeps one decimal under 100 units and none from 100 up', () => {
  assert.equal(signedUsd(999), '+$999');
  assert.equal(signedUsd(-999), '\u2212$999');
  assert.equal(signedUsd(1_000), '+$1.0K');
  // Sub-100K values keep one decimal even when it rounds to 100.0.
  assert.equal(signedUsd(99_950), '+$100.0K');
  assert.equal(signedUsd(99_949), '+$99.9K');
  assert.equal(signedUsd(100_000), '+$100K');
  assert.equal(signedUsd(999_999), '+$1.0M');
  assert.equal(signedUsd(1_000_000), '+$1.0M');
});

test('signedUsd rejects non-finite values', () => {
  assert.equal(signedUsd(Number.NaN), '');
  assert.equal(signedUsd(Number.POSITIVE_INFINITY), '');
});

test('tradeValueSigned signs buys positive and sells negative', () => {
  assert.equal(tradeValueSigned(trade({ action: 'buy', valueUsd: 84_200 })), '+$84.2K');
  assert.equal(tradeValueSigned(trade({ action: 'sell', valueUsd: 15_000 })), '\u2212$15.0K');
  // Null values stay blank.
  assert.equal(tradeValueSigned(trade({ valueUsd: null })), '');
  // Zero is still rendered (unsigned zero).
  assert.equal(tradeValueSigned(trade({ valueUsd: 0 })), '$0');
});

test('timeAgo gives short ages and timeAgoLong appends ago', () => {
  assert.equal(timeAgo(ago(0.5), NOW), 'just now');
  assert.equal(timeAgo(ago(12), NOW), '12m');
  assert.equal(timeAgo(ago(90), NOW), '1h');
  assert.equal(timeAgo(ago(120), NOW), '2h');
  assert.equal(timeAgo(ago(1_440), NOW), '1d');
  assert.equal(timeAgo(ago(4_320), NOW), '3d');
  assert.equal(timeAgoLong(ago(12), NOW), '12m ago');
  assert.equal(timeAgoLong(ago(120), NOW), '2h ago');
  assert.equal(timeAgoLong(ago(4_320), NOW), '3d ago');
  assert.equal(timeAgoLong(ago(0.5), NOW), 'just now');
  // Future stamps are 'just now', never negative.
  assert.equal(timeAgo(new Date(NOW.getTime() + 5 * 60_000).toISOString(), NOW), 'just now');
});

test('timeAgo and timeAgoLong reject unusable stamps', () => {
  assert.equal(timeAgo('not-a-date', NOW), '');
  assert.equal(timeAgoLong('not-a-date', NOW), '');
});

test('walletSample derives stable metrics per address and honours the mock gate', () => {
  const address = '7xQpWWWWWWWWWWWWWWW3fA';
  const first = walletSample(address, true);
  assert.equal(first, WALLET_SAMPLE.get(address));
  assert.deepEqual(first, walletSample(address, true));
  assert.ok(first !== null);
  assert.ok(Number.isInteger(first!.winRate));
  assert.ok(first!.winRate >= 0 && first!.winRate <= 100);
  assert.ok(Number.isFinite(first!.pnlUsd));
  // Off → null, and the cache stays empty for that address.
  WALLET_SAMPLE.delete(address);
  assert.equal(walletSample(address, false), null);
  assert.equal(WALLET_SAMPLE.has(address), false);
  assert.equal(walletSample('other-address-123', false), null);
});

test('walletSample spreads values across addresses without leaving the ranges', () => {
  const addresses = ['walletA', 'walletB', 'walletC', 'walletD', '9KdWWWWWWWWWWWWWWWe21',
    'Fq2WWWWWWWWWWWWWWWk9L', '3mNWWWWWWWWWWWWWWWpQ7'];
  const samples = addresses.map((address) => {
    const sample = walletSample(address, true);
    assert.ok(sample !== null);
    return sample;
  });
  for (const sample of samples) {
    assert.ok(sample.pnlUsd >= -500_000 && sample.pnlUsd <= 500_000, `pnl out of range: ${sample.pnlUsd}`);
    assert.ok(sample.winRate >= 0 && sample.winRate <= 100);
    assert.ok(Number.isInteger(sample.pnlUsd));
  }
  // At least two distinct PnL values for a spread of addresses.
  const pnls = new Set(samples.map((sample) => sample.pnlUsd));
  assert.ok(pnls.size > 1);
});

test('rankRows ranks by sample PnL when mocks are on and keeps grouping order when off', () => {
  const rows = groupByWallet([
    trade({ id: 't1', walletAddress: 'walletA' }),
    trade({ id: 't2', walletAddress: 'walletB', valueUsd: 10_000 }),
    trade({ id: 't3', walletAddress: 'walletC', valueUsd: 5_000 }),
  ]);
  const ranked = rankRows(rows, true);
  assert.deepEqual(ranked.map((item) => item.rank), [1, 2, 3]);
  const pnls = ranked.map((item) => walletSample(item.address, true)!.pnlUsd);
  assert.deepEqual(pnls, [...pnls].sort((a, b) => b - a));
  // Mocks off: groupByWallet order, plain 1..n ranks.
  const unranked = rankRows(rows, false);
  assert.deepEqual(unranked.map((item) => item.address), rows.map((item) => item.address));
  assert.deepEqual(unranked.map((item) => item.rank), [1, 2, 3]);
});

test('swapHref points at the swap screen in buy mode for the tapped token', () => {
  assert.deepEqual(swapHref(trade()), {
    pathname: '/swap',
    params: { mode: 'buy', token: JUP.address, caller: 'feed' },
  });
  assert.deepEqual(swapHref(trade({ tokenAddress: WIF.address })), {
    pathname: '/swap',
    params: { mode: 'buy', token: WIF.address, caller: 'feed' },
  });
});
test('leaderboardRankLabel says volume when mocks are off and PnL when on', () => {
  assert.equal(leaderboardRankLabel(false), 'Ranked by volume · 30d');
  assert.equal(leaderboardRankLabel(true), '30d PnL · Win');
});
