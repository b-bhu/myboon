import { useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusedAppStateInterval } from '@/hooks/useFocusedAppStateInterval';
import { fetchWalletActivity } from './wallet-activity.api';
import { groupByWallet, rankRows, shortAddress, signedUsd, walletSample, walletSubline } from './feed-wallets';
import type { WalletRow } from './feed-wallets';
import { FEED_TOKENS, monoFontFamily } from './feed-design';
import { FEED_MOCKS } from './feed-mocks';
import { useFeedSection } from './use-feed-section';
import { FeedSectionState } from './components/feed-section-state';
import { SampleDataLabel } from './components/ui/SampleDataLabel';
import { WalletSheet } from './components/WalletSheet';

/**
 * Full-screen smart-wallet leaderboard (issue #499, markup per feed-mock.html
 * #s-wallets, DESIGN.md §7): top bar, one boxed table ranked by PnL (mocked)
 * or by grouped volume when mocks are off, rows open the wallet sheet.
 * Trades come from the Birdeye wallet-activity data; times are the device's
 * local age labels.
 */
export default function WalletsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const section = useFeedSection(fetchWalletActivity);
  useFocusedAppStateInterval(() => { void section.load(); }, 5 * 60_000);
  const [sheetAddress, setSheetAddress] = useState<string | null>(null);

  const data = section.data;
  const expired = !!data?.fetchedAt && Date.now() - Date.parse(data.fetchedAt) > 6 * 60 * 60_000;
  const usable = !!data && data.status !== 'unavailable' && !expired;
  const retryable = data?.error?.retryable !== false;
  const rows: WalletRow[] = usable ? groupByWallet(data.activities) : [];
  const ranked = rankRows(rows);
  const sheetRow = sheetAddress ? ranked.find((row) => row.address === sheetAddress) ?? null : null;

  return (
    <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={styles.bar}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={() => router.back()}
          style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
        >
          <Text style={styles.backGlyph}>‹</Text>
        </Pressable>
        <Text accessibilityRole="header" style={styles.barLabel}>Smart wallets</Text>
        <View style={styles.barSpacer} />
      </View>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={section.loading}
            onRefresh={() => { void section.load(); }}
            tintColor={FEED_TOKENS.colors.accent}
            colors={[FEED_TOKENS.colors.accent]}
          />
        }
      >
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
        {section.error && usable ? <Text selectable style={styles.notice}>Refresh failed; showing the last fetched activity.</Text> : null}
        {usable && (data?.partial || data?.stale) ? (
          <Text selectable style={styles.notice}>
            {data?.stale ? 'Showing saved activity; refresh is unavailable.' : 'Partial coverage; some wallets could not be checked.'}
          </Text>
        ) : null}
        {usable && rows.length === 0 ? (
          <FeedSectionState
            title={data?.partial ? 'No activity from available checks' : 'No swaps in this sample'}
            text={data?.partial ? 'Some wallets could not be checked. Try again later.' : 'No supported swaps were found in the last 30 days for the sampled wallets.'}
          />
        ) : null}
        {usable && ranked.length ? (
          <>
            {FEED_MOCKS ? <SampleDataLabel /> : null}
            <View style={styles.table}>
              <View style={styles.headerRow}>
                <Text style={styles.headLeft}># · Wallet</Text>
                <Text style={styles.headRight}>{FEED_MOCKS ? '30d PnL · Win' : 'Volume'}</Text>
              </View>
              {ranked.map((row) => {
                const sample = walletSample(row.address);
                return (
                  <Pressable
                    key={row.address}
                    accessibilityRole="button"
                    accessibilityLabel={`Rank ${row.rank}, wallet ${shortAddress(row.address)}, ${walletSubline(row)}`}
                    onPress={() => setSheetAddress(row.address)}
                    style={({ pressed }) => [styles.row, pressed && styles.pressed]}
                  >
                    <View style={styles.rankTile} accessibilityElementsHidden>
                      <Text style={styles.rank}>{row.rank}</Text>
                    </View>
                    <View style={styles.identity}>
                      <Text style={styles.walletAddress}>{shortAddress(row.address)}</Text>
                      <Text style={styles.walletSub} numberOfLines={1}>{walletSubline(row)}</Text>
                    </View>
                    {FEED_MOCKS && sample ? (
                      <View style={styles.metrics}>
                        <Text style={[styles.pnl, { color: sample.pnlUsd >= 0 ? FEED_TOKENS.colors.up : FEED_TOKENS.colors.down }]}>
                          {signedUsd(sample.pnlUsd)}
                        </Text>
                        <Text style={styles.winRate}>{sample.winRate}%</Text>
                      </View>
                    ) : (
                      <Text style={styles.volume}>{signedUsd(row.volumeUsd).replace(/^\+/, '')}</Text>
                    )}
                  </Pressable>
                );
              })}
            </View>
            <Text selectable style={styles.footer}>
              Limited sample · {data?.coverage.walletCount ?? 0} wallets · {data?.coverage.tokens.map((token) => token.symbol).join(', ') || 'no active tokens'} · past 30 days
            </Text>
          </>
        ) : null}
      </ScrollView>
      <WalletSheet wallet={sheetRow} onClose={() => setSheetAddress(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: FEED_TOKENS.colors.screen,
  },
  bar: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: FEED_TOKENS.space.lg,
  },
  backButton: {
    minHeight: 44,
    width: 32,
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  backGlyph: {
    color: FEED_TOKENS.colors.text,
    fontSize: FEED_TOKENS.type.title,
  },
  barLabel: {
    color: FEED_TOKENS.colors.text,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  barSpacer: {
    width: 32,
  },
  pressed: {
    opacity: 0.76,
  },
  content: {
    paddingTop: FEED_TOKENS.space.xs,
    paddingBottom: FEED_TOKENS.space.xl,
    paddingHorizontal: FEED_TOKENS.space.lg,
    gap: FEED_TOKENS.space.md,
  },
  notice: {
    color: FEED_TOKENS.colors.accent,
    fontSize: FEED_TOKENS.type.caption,
    lineHeight: 17,
  },
  // One bordered box for the whole leaderboard; hairline rows ~58 tall.
  table: {
    borderWidth: 1,
    borderColor: FEED_TOKENS.colors.border,
    borderRadius: FEED_TOKENS.radius.card,
    backgroundColor: FEED_TOKENS.colors.card,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: FEED_TOKENS.space.sm,
    paddingHorizontal: FEED_TOKENS.space.md,
    paddingVertical: FEED_TOKENS.space.sm,
  },
  headLeft: {
    color: FEED_TOKENS.colors.textFaint,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  headRight: {
    color: FEED_TOKENS.colors.textFaint,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    letterSpacing: 1,
    textTransform: 'uppercase',
    textAlign: 'right',
  },
  row: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    gap: FEED_TOKENS.space.md,
    borderTopWidth: 0.5,
    borderTopColor: FEED_TOKENS.colors.border,
    paddingHorizontal: FEED_TOKENS.space.md,
    paddingVertical: FEED_TOKENS.space.sm,
  },
  rankTile: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: FEED_TOKENS.colors.border,
  },
  rank: {
    color: FEED_TOKENS.colors.textDim,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.caption,
  },
  identity: {
    flex: 1,
    gap: 2,
  },
  walletAddress: {
    color: FEED_TOKENS.colors.text,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.body,
    fontWeight: '600',
  },
  walletSub: {
    color: FEED_TOKENS.colors.textDim,
    fontSize: FEED_TOKENS.type.caption,
    lineHeight: 15,
  },
  metrics: {
    alignItems: 'flex-end',
    gap: 2,
  },
  pnl: {
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.secondary,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  winRate: {
    color: FEED_TOKENS.colors.textDim,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.caption,
  },
  volume: {
    color: FEED_TOKENS.colors.text,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.secondary,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  footer: {
    color: FEED_TOKENS.colors.textFaint,
    fontSize: FEED_TOKENS.type.caption,
    lineHeight: 17,
  },
});