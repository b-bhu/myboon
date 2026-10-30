import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { signedUsd, swapHref, timeAgo, timeAgoLong, tradeValueSigned, walletLabelText, walletSample } from '../feed-wallets';
import type { WalletRow } from '../feed-wallets';
import type { WalletActivity } from '../wallet-activity.types';
import { FEED_TOKENS, monoFontFamily } from '../feed-design';
import { formatFeedUsd } from '../feed-format';
import { FeedSheet } from './ui/FeedSheet';
import { SampleDataLabel } from './ui/SampleDataLabel';

/**
 * Amount text for the sheet's Amount box: compact K/M/B like the mock, plain
 * figures below a thousand tokens (Hermes lacks safe Intl compact notation).
 */
export function amountText(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '—';
  if (value < 0.000001) return value.toExponential(2);
  const trim = (text: string) => text.replace(/\.0$/, '');
  if (value >= 1e6) return `${trim((value / 1e6).toFixed(1))}M`;
  if (value >= 1e3) return `${trim((value / 1e3).toFixed(1))}K`;
  return value.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

interface WalletSheetProps {
  wallet: WalletRow | null;
  onClose: () => void;
}

/**
 * Wallet bottom sheet (feed-mock.html #s-tradesheet, DESIGN.md §12): the
 * wallet's latest trade, its address and figures, the real trade count, the
 * mocked 30d PnL / win rate rows (sample-gated), the recent-trade list and
 * the gold Trade CTA into swap. Trades come from the grouped activity.
 */
export function WalletSheet({ wallet, onClose }: WalletSheetProps) {
  const router = useRouter();
  const now = new Date();
  const last: WalletActivity | null = wallet?.last ?? null;
  const sample = wallet ? walletSample(wallet.address) : null;
  return (
    <FeedSheet visible={wallet !== null && last !== null} onClose={onClose}>
      {wallet && last ? (
        <View>
          <View style={styles.metaRow}>
            <Text accessibilityRole="header" style={styles.meta}>
              {walletLabelText(wallet.labels)}
              {wallet.labels.length ? ' · ' : ''}
              Solana
            </Text>
            <Text style={styles.metaAge}>{timeAgoLong(last.observedAt, now)}</Text>
          </View>
          <Text style={styles.title}>{last.action === 'buy' ? 'Bought' : 'Sold'} {last.tokenSymbol}</Text>
          <Text selectable style={styles.address}>{wallet.address}</Text>
          <View style={styles.figures}>
            <View style={styles.figureBox}>
              <Text style={styles.figureLabel}>Value</Text>
              <Text style={[styles.figureValue, { color: last.action === 'buy' ? FEED_TOKENS.colors.up : FEED_TOKENS.colors.down }]}>
                {formatFeedUsd(last.valueUsd, true)}
              </Text>
            </View>
            <View style={styles.figureBox}>
              <Text style={styles.figureLabel}>Amount</Text>
              <Text style={styles.figureValue}>{amountText(last.amount)}</Text>
            </View>
            <View style={styles.figureBox}>
              <Text style={styles.figureLabel}>Price</Text>
              <Text style={styles.figureValue}>{formatFeedUsd(last.priceUsd)}</Text>
            </View>
          </View>
          <View style={styles.section}>
            <Text style={styles.sectionHeading}>THIS WALLET · 30D</Text>
            {sample ? <SampleDataLabel /> : null}
            <View style={styles.statCard}>
              <View style={styles.statRow}>
                <Text style={styles.statLabel}>Trades</Text>
                <Text style={styles.statValue}>{wallet.tradeCount}</Text>
              </View>
              {sample ? (
                <>
                  <View style={styles.statRow}>
                    <Text style={styles.statLabel}>Realised PnL</Text>
                    <Text style={[styles.statValue, { color: sample.pnlUsd >= 0 ? FEED_TOKENS.colors.up : FEED_TOKENS.colors.down }]}>
                      {signedUsd(sample.pnlUsd)}
                    </Text>
                  </View>
                  <View style={styles.statRow}>
                    <Text style={styles.statLabel}>Win rate</Text>
                    <Text style={styles.statValue}>{sample.winRate}%</Text>
                  </View>
                </>
              ) : null}
            </View>
          </View>
          <View style={styles.section}>
            <Text style={styles.sectionHeading}>RECENT TRADES</Text>
            <View style={styles.tradeList}>
              {wallet.trades.slice(0, 10).map((trade) => (
                <View key={trade.id} style={styles.tradeRow}>
                  <Text style={styles.tradeTitle}>{trade.action === 'buy' ? 'Bought' : 'Sold'} {trade.tokenSymbol}</Text>
                  <Text style={[styles.tradeValue, { color: trade.action === 'buy' ? FEED_TOKENS.colors.up : FEED_TOKENS.colors.down }]}>
                    {tradeValueSigned(trade)}
                  </Text>
                  <Text style={styles.tradeAge}>{timeAgo(trade.observedAt, now)}</Text>
                </View>
              ))}
            </View>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Trade ${last.tokenSymbol}`}
            onPress={() => {
              onClose();
              router.push(swapHref(last));
            }}
            style={styles.tradeButton}
          >
            <Text style={styles.tradeButtonLabel}>Trade {last.tokenSymbol}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="link"
            accessibilityLabel="Open this wallet on Solscan"
            onPress={() => { void Linking.openURL(`https://solscan.io/account/${wallet.address}`); }}
            style={styles.sourceLink}
          >
            <Text style={styles.sourceLinkLabel}>View on Solscan ↗</Text>
          </Pressable>
        </View>
      ) : null}
    </FeedSheet>
  );
}

const styles = StyleSheet.create({
  metaRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: FEED_TOKENS.space.sm,
    marginBottom: FEED_TOKENS.space.sm,
  },
  meta: {
    color: FEED_TOKENS.colors.text,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    letterSpacing: 1,
    textTransform: 'uppercase',
    flexShrink: 1,
  },
  metaAge: {
    color: FEED_TOKENS.colors.textDim,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    letterSpacing: 1,
  },
  title: {
    color: FEED_TOKENS.colors.text,
    fontSize: FEED_TOKENS.type.section,
    lineHeight: 25,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  address: {
    color: FEED_TOKENS.colors.textDim,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.caption,
    lineHeight: 18,
    marginTop: FEED_TOKENS.space.xs,
  },
  figures: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: FEED_TOKENS.space.sm,
    marginTop: FEED_TOKENS.space.md,
  },
  figureBox: {
    flexBasis: '30%',
    flexGrow: 1,
    borderWidth: 1,
    borderColor: FEED_TOKENS.colors.border,
    borderRadius: FEED_TOKENS.radius.card,
    backgroundColor: FEED_TOKENS.colors.card,
    padding: FEED_TOKENS.space.md,
    gap: FEED_TOKENS.space.xs,
  },
  figureLabel: {
    color: FEED_TOKENS.colors.textFaint,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  figureValue: {
    color: FEED_TOKENS.colors.text,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.body,
    fontWeight: '700',
  },
  section: {
    marginTop: FEED_TOKENS.space.xl,
    gap: FEED_TOKENS.space.sm,
  },
  sectionHeading: {
    color: FEED_TOKENS.colors.text,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  statCard: {
    borderWidth: 1,
    borderColor: FEED_TOKENS.colors.border,
    borderRadius: FEED_TOKENS.radius.card,
    backgroundColor: FEED_TOKENS.colors.card,
    padding: FEED_TOKENS.space.md,
    gap: FEED_TOKENS.space.sm,
  },
  statRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: FEED_TOKENS.space.sm,
  },
  statLabel: {
    color: FEED_TOKENS.colors.textFaint,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  statValue: {
    color: FEED_TOKENS.colors.text,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.secondary,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  tradeList: {
    borderTopWidth: 1,
    borderTopColor: FEED_TOKENS.colors.border,
  },
  tradeRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    borderTopWidth: 1,
    borderTopColor: FEED_TOKENS.colors.border,
    paddingVertical: FEED_TOKENS.space.sm,
    gap: FEED_TOKENS.space.sm,
  },
  tradeTitle: {
    flex: 1,
    color: FEED_TOKENS.colors.text,
    fontSize: FEED_TOKENS.type.secondary,
  },
  tradeValue: {
    color: FEED_TOKENS.colors.up,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.secondary,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  tradeAge: {
    color: FEED_TOKENS.colors.textDim,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.caption,
    minWidth: 30,
    textAlign: 'right',
  },
  tradeButton: {
    marginTop: FEED_TOKENS.space.xl,
    minHeight: 48,
    borderWidth: 1,
    borderColor: FEED_TOKENS.colors.accent,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tradeButtonLabel: {
    color: FEED_TOKENS.colors.accent,
    fontSize: FEED_TOKENS.type.body,
    fontWeight: '600',
  },
  sourceLink: {
    marginTop: FEED_TOKENS.space.md,
    minHeight: 44,
    alignSelf: 'flex-start',
    justifyContent: 'center',
  },
  sourceLinkLabel: {
    color: FEED_TOKENS.colors.accent,
    fontSize: FEED_TOKENS.type.caption,
    fontWeight: '700',
  },
});