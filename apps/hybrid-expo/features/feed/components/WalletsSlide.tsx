import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusedAppStateInterval } from '@/hooks/useFocusedAppStateInterval';
import { fetchWalletActivity } from '../wallet-activity.api';
import type { WalletActivity } from '../wallet-activity.types';
import { groupByWallet, mostBought, shortAddress, signedUsd, timeAgo, tradeValueSigned, walletLabelText } from '../feed-wallets';
import type { WalletRow } from '../feed-wallets';
import { FEED_TOKENS, monoFontFamily } from '../feed-design';
import { useFeedSection } from '../use-feed-section';
import { FeedSectionState } from './feed-section-state';
import { FeedBox } from './ui/FeedBox';
import { WalletSheet } from './WalletSheet';

interface WalletsSlideProps {
  active: boolean;
  refreshVersion: number;
}

/**
 * Smart wallets slide (feed-mock.html #s-slides second card, DESIGN.md §7):
 * the most-bought token with its signed net, the newest observed trade and
 * the 'Leaderboard' link into the full screen. Trades, buyers and sellers are
 * live Birdeye data; nothing on the slide is mocked.
 */
export function WalletsSlide({ active, refreshVersion }: WalletsSlideProps) {
  const router = useRouter();
  const section = useFeedSection(fetchWalletActivity, active);
  const previousRefresh = useRef(refreshVersion);
  useEffect(() => {
    if (previousRefresh.current === refreshVersion) return;
    previousRefresh.current = refreshVersion;
    if (active) void section.load();
  }, [active, refreshVersion, section.load]);
  useFocusedAppStateInterval(() => { void section.load(); }, 5 * 60_000, { enabled: active });
  const [sheetAddress, setSheetAddress] = useState<string | null>(null);

  const data = section.data;
  // Saved activity beyond 6h is treated as unusable, as elsewhere on the feed.
  const expired = !!data?.fetchedAt && Date.now() - Date.parse(data.fetchedAt) > 6 * 60 * 60_000;
  const usable = !!data && data.status !== 'unavailable' && !expired;
  const retryable = data?.error?.retryable !== false;
  const activities: WalletActivity[] = usable ? data.activities : [];
  const rows: WalletRow[] = usable ? groupByWallet(activities) : [];
  const top = usable ? mostBought(activities) : null;
  // One newest trade across all wallets: every row keeps its own newest first.
  const latestRow = rows.reduce<WalletRow | null>((newest, row) => {
    if (!newest) return row;
    if (Date.parse(row.last.observedAt) > Date.parse(newest.last.observedAt)) return row;
    return Date.parse(row.last.observedAt) === Date.parse(newest.last.observedAt) && row.last.id < newest.last.id ? row : newest;
  }, null);
  const sheetRow = sheetAddress ? rows.find((row) => row.address === sheetAddress) ?? null : null;

  return (
    <View>
      {section.loading && !data ? <FeedSectionState title="Loading wallet activity…" loading /> : null}
      {section.error && !data ? (
        <FeedSectionState title="Activity refresh failed" text="Wallet activity could not be loaded." onRetry={() => { void section.load(); }} />
      ) : null}
      {data && !usable && !section.error ? (
        <FeedSectionState
          title="Activity unavailable"
          text={expired ? 'Saved activity has expired.' : 'Tagged wallet activity is not available right now.'}
          onRetry={retryable ? () => { void section.load(); } : undefined}
        />
      ) : null}
      {section.error && usable ? <Text style={styles.notice}>Refresh failed; showing the last fetched activity.</Text> : null}
      {usable && (rows.length === 0 || !top) ? (
        <FeedSectionState
          title={data?.partial ? 'No activity from available checks' : 'No swaps in this sample'}
          text={data?.partial ? 'Some wallets could not be checked. Try again later.' : 'No supported swaps were found in the last 30 days for the sampled wallets.'}
        />
      ) : null}
      {usable && top && latestRow ? (
        <FeedBox tone="ground" style={styles.card} accessibilityLabel={`Smart wallets 30 day. Most bought: ${top.symbol}, net ${signedUsd(top.netUsd)}, ${top.buyers} wallets bought, ${top.sellers} sold`}>
          <View style={styles.headerRow}>
            <Text style={styles.monoCaps}>SMART WALLETS · 30D</Text>
            <Pressable
              accessibilityRole="link"
              accessibilityLabel="Open smart wallet leaderboard"
              onPress={() => {
                setSheetAddress(null);
                router.push('/wallets');
              }}
              style={styles.linkTouch}
            >
              <Text style={styles.link}>Leaderboard →</Text>
            </Pressable>
          </View>
          <Text style={styles.caption}>Most bought</Text>
          <View style={styles.tokenRow}>
            <Text style={styles.token}>{top.symbol}</Text>
            <Text style={[styles.net, { color: top.netUsd >= 0 ? FEED_TOKENS.colors.up : FEED_TOKENS.colors.down }]}>
              {signedUsd(top.netUsd)}
            </Text>
          </View>
          <Text style={styles.caption}>{top.buyers} wallets bought · {top.sellers} sold</Text>
          <View style={styles.divider} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${latestRow.last.action === 'buy' ? 'Bought' : 'Sold'} ${latestRow.last.tokenSymbol}, value ${tradeValueSigned(latestRow.last)}, ${timeAgo(latestRow.last.observedAt)}, open wallet ${shortAddress(latestRow.address)}`}
            onPress={() => setSheetAddress(latestRow.address)}
            style={({ pressed }) => [styles.tradeRow, pressed && styles.pressed]}
          >
            <View style={{ flex: 1 }}>
              <Text style={styles.tradeTitle}>{latestRow.last.action === 'buy' ? 'Bought' : 'Sold'} {latestRow.last.tokenSymbol}</Text>
              <Text style={styles.tradeMeta} numberOfLines={1}>
                {walletLabelText(latestRow.labels)}
                {latestRow.labels.length ? ' · ' : ''}
                {shortAddress(latestRow.address)}
              </Text>
            </View>
            <View style={styles.tradeRight}>
              <Text style={[styles.tradeValue, { color: latestRow.last.action === 'buy' ? FEED_TOKENS.colors.up : FEED_TOKENS.colors.down }]}>
                {tradeValueSigned(latestRow.last)}
              </Text>
              <Text style={styles.tradeMeta}>{timeAgo(latestRow.last.observedAt)}</Text>
            </View>
          </Pressable>
          <View style={styles.footer}>
            <Text style={styles.monoCaps}>Birdeye · {data?.coverage.walletCount ?? 0} wallets</Text>
          </View>
        </FeedBox>
      ) : null}
      <WalletSheet wallet={sheetRow} onClose={() => setSheetAddress(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  // Mock .card.sl is a 236-tall boxed card; keep at least that much room.
  card: {
    minHeight: 236,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: FEED_TOKENS.space.sm,
  },
  monoCaps: {
    color: FEED_TOKENS.colors.textDim,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  linkTouch: {
    minHeight: 44,
    justifyContent: 'center',
  },
  pressed: {
    opacity: 0.76,
  },
  link: {
    color: FEED_TOKENS.colors.accent,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    fontWeight: '600',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  caption: {
    color: FEED_TOKENS.colors.textDim,
    fontSize: FEED_TOKENS.type.label,
    lineHeight: 15,
  },
  tokenRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: FEED_TOKENS.space.sm,
    marginVertical: FEED_TOKENS.space.xs,
  },
  token: {
    color: FEED_TOKENS.colors.text,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.big,
    fontWeight: '700',
  },
  net: {
    color: FEED_TOKENS.colors.up,
    fontFamily: monoFontFamily(),
    fontSize: 18,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  divider: {
    borderTopWidth: 1,
    borderTopColor: FEED_TOKENS.colors.border,
    marginTop: FEED_TOKENS.space.sm,
    marginBottom: FEED_TOKENS.space.sm,
  },
  tradeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: FEED_TOKENS.space.sm,
    minHeight: 44,
  },
  tradeTitle: {
    color: FEED_TOKENS.colors.text,
    fontSize: FEED_TOKENS.type.body,
    fontWeight: '600',
  },
  tradeMeta: {
    color: FEED_TOKENS.colors.textDim,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.caption,
    lineHeight: 17,
  },
  tradeRight: {
    alignItems: 'flex-end',
    gap: 2,
  },
  tradeValue: {
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.secondary,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  footer: {
    borderTopWidth: 1,
    borderTopColor: FEED_TOKENS.colors.border,
    marginTop: FEED_TOKENS.space.md,
    paddingTop: FEED_TOKENS.space.md,
  },
  notice: {
    color: FEED_TOKENS.colors.accent,
    fontSize: FEED_TOKENS.type.caption,
    lineHeight: 17,
  },
});