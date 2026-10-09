import { useEffect, useRef, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusedAppStateInterval } from '@/hooks/useFocusedAppStateInterval';
import { FEED_COLORS as color } from '../feed.constants';
import { formatFeedUsd } from '../feed-format';
import { fetchWalletActivity } from '../wallet-activity.api';
import type { WalletActivity, WalletActivityResult, WalletLabel } from '../wallet-activity.types';
import { useFeedSection } from '../use-feed-section';
import { FeedDetailSheet } from './feed-detail-sheet';
import { FeedSectionState } from './feed-section-state';

const fetchActivity = (signal: AbortSignal) => fetchWalletActivity(signal);
const labels = (values: WalletLabel[]) => values.map((value) => value === 'kol' ? 'KOL' : 'Smart trader').join(' · ');
const shortAddress = (value: string) => `${value.slice(0, 5)}…${value.slice(-4)}`;
const eventTime = (value: string) => `${new Date(value).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC`;
const amount = (value: number) => value < 0.000001 ? value.toExponential(2) : value.toLocaleString('en-US', { maximumFractionDigits: 6 });
type Panel = { snapshot: WalletActivityResult; selected: WalletActivity | null; fromList: boolean };

function ActivityCard({ activity, onPress }: { activity: WalletActivity; onPress: () => void }) {
  const direction = activity.action === 'buy' ? 'Bought' : 'Sold';
  return <Pressable accessibilityRole="button" accessibilityLabel={`${labels(activity.walletLabels)}, ${shortAddress(activity.walletAddress)}, ${direction} ${amount(activity.amount)} ${activity.tokenSymbol}, ${eventTime(activity.observedAt)}`} onPress={onPress} style={styles.card}>
    <View style={styles.cardTop}>
      <View style={styles.identity}>
        <Text style={styles.label}>{labels(activity.walletLabels)}</Text>
        <Text style={styles.wallet}>{shortAddress(activity.walletAddress)}</Text>
      </View>
      <View style={styles.amount}>
        <Text style={styles.quantity}>{amount(activity.amount)}</Text>
        <Text style={styles.small}>{activity.tokenSymbol}</Text>
      </View>
    </View>
    <Text style={[styles.direction, { color: activity.action === 'buy' ? '#91DFBE' : '#F8A5A5' }]}>{direction} {activity.tokenSymbol}</Text>
    <View style={styles.footer}><Text style={styles.small}>Birdeye · {eventTime(activity.observedAt)}</Text><Text style={styles.action}>View activity →</Text></View>
  </Pressable>;
}

export function SmartWalletActivity({ active = true, refreshVersion = 0 }: { active?: boolean; refreshVersion?: number }) {
  const section = useFeedSection(fetchActivity, active);
  const previousRefresh = useRef(refreshVersion);
  useEffect(() => {
    if (previousRefresh.current === refreshVersion) return;
    previousRefresh.current = refreshVersion;
    if (active) void section.load();
  }, [active, refreshVersion, section.load]);
  useFocusedAppStateInterval(() => section.load(), 5 * 60_000, { enabled: active });
  const [panel, setPanel] = useState<Panel | null>(null);
  const data = section.data;
  const expired = !!data?.fetchedAt && Date.now() - Date.parse(data.fetchedAt) > 6 * 60 * 60_000;
  const usable = !!data && data.status !== 'unavailable' && !expired;
  const retryable = data?.error?.retryable !== false;
  const open = (selected: WalletActivity | null, fromList: boolean) => {
    if (data && usable) setPanel({ snapshot: data, selected, fromList });
  };
  const close = () => {
    if (panel?.selected && panel.fromList) setPanel({ ...panel, selected: null });
    else setPanel(null);
  };
  return <View style={styles.section}>
    <View style={styles.heading}><Text accessibilityRole="header" style={styles.title}>Smart wallet activity</Text>
      {usable && data.activities.length ? <Pressable accessibilityRole="button" accessibilityLabel="All smart wallet activity" onPress={() => open(null, true)} style={styles.touch}><Text style={styles.action}>All activity →</Text></Pressable> : null}
    </View>
    <Text style={styles.small}>Observed swaps from sampled KOL and smart-trader wallets · Solana</Text>
    <View style={styles.content}>
      {section.loading && !data ? <FeedSectionState title="Loading wallet activity…" loading /> : null}
      {section.error ? <FeedSectionState title="Activity refresh failed" text={usable ? 'Showing the last fetched activity.' : 'Wallet activity could not be loaded.'} onRetry={() => { void section.load(); }} /> : null}
      {data && (!usable && !section.error) ? <FeedSectionState title="Activity unavailable" text={expired ? 'Saved activity has expired.' : 'Tagged wallet activity is not available right now.'} onRetry={retryable ? () => { void section.load(); } : undefined} /> : null}
      {usable ? <>
        {data.partial || data.stale ? <Text style={styles.notice}>{data.stale ? 'Showing saved activity; refresh is unavailable.' : 'Partial coverage; some wallets could not be checked.'}</Text> : null}
        {data.activities.length ? <ActivityCard activity={data.activities[0]!} onPress={() => open(data.activities[0]!, false)} /> : <FeedSectionState title={data.partial ? 'No activity from available checks' : 'No swaps in this sample'} text={data.partial ? 'Some wallets could not be checked. Try again later.' : 'No supported swaps were found in the last 30 days for the sampled wallets.'} />}
        <Text selectable style={styles.small}>Coverage: {data.coverage.tokens.map((row) => row.symbol).join(', ') || 'no active tokens'} · {data.coverage.walletCount} wallets · past 30 days</Text>
        <Text selectable style={styles.small}>Birdeye · fetched {eventTime(data.fetchedAt!)} · updates hourly</Text>
      </> : null}
    </View>
    <FeedDetailSheet visible={!!panel} title={panel?.selected ? 'Wallet activity' : 'All wallet activity'} onClose={close}>
      {panel?.selected ? <>
        {panel.fromList ? <Pressable accessibilityRole="button" onPress={() => setPanel({ ...panel, selected: null })} style={styles.touch}><Text style={styles.action}>← All activity</Text></Pressable> : null}
        <Text selectable style={styles.detailTitle}>{panel.selected.action === 'buy' ? 'Bought' : 'Sold'} {amount(panel.selected.amount)} {panel.selected.tokenSymbol}</Text>
        <Text selectable style={styles.body}>{eventTime(panel.selected.observedAt)} · Solana</Text>
        <Text style={styles.label}>{labels(panel.selected.walletLabels)}</Text>
        <Text selectable style={styles.address}>{panel.selected.walletAddress}</Text>
        <Text style={styles.small}>Birdeye classification for {panel.selected.classificationToken.symbol}. This records an observed swap by this wallet.</Text>
        <Text selectable style={styles.body}>Price at swap: {formatFeedUsd(panel.selected.priceUsd)}{ '\n' }Swap value: {formatFeedUsd(panel.selected.valueUsd)}</Text>
        <Text style={styles.small}>Token address</Text><Text selectable style={styles.address}>{panel.selected.tokenAddress}</Text>
        <Text style={styles.small}>Transaction</Text><Text selectable style={styles.address}>{panel.selected.signature}</Text>
        <Pressable accessibilityRole="link" accessibilityLabel="View this transaction on Solscan" onPress={() => { void Linking.openURL(`https://solscan.io/tx/${panel.selected!.signature}`); }} style={styles.touch}><Text style={styles.action}>View transaction ↗</Text></Pressable>
        <Text selectable style={styles.small}>Birdeye · fetched {eventTime(panel.snapshot.fetchedAt!)}{panel.snapshot.stale ? ' · Saved data' : ''}</Text>
      </> : panel ? <>
        <Text style={styles.small}>Limited sample · {panel.snapshot.coverage.walletCount} wallets · {panel.snapshot.coverage.tokens.map((row) => row.symbol).join(', ')} · past 30 days</Text>
        {panel.snapshot.activities.map((activity) => <ActivityCard key={activity.id} activity={activity} onPress={() => setPanel({ ...panel, selected: activity })} />)}
        <Text style={styles.small}>Birdeye · fetched {eventTime(panel.snapshot.fetchedAt!)}</Text>
      </> : null}
    </FeedDetailSheet>
  </View>;
}

const styles = StyleSheet.create({
  section: { gap: 12 }, content: { minHeight: 150, gap: 12 },
  heading: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  title: { color: color.text, fontSize: 22, lineHeight: 29, fontWeight: '800' },
  touch: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 4 },
  action: { color: color.accent, fontSize: 12, lineHeight: 18, fontWeight: '700' },
  card: { minHeight: 145, padding: 14, gap: 10, borderWidth: 1, borderColor: color.border, borderRadius: 9, backgroundColor: color.card },
  cardTop: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, justifyContent: 'space-between' },
  identity: { flexGrow: 1, gap: 4 }, label: { color: color.textDim, fontSize: 12, lineHeight: 18, fontWeight: '700' },
  wallet: { color: color.text, fontSize: 16, lineHeight: 22, fontWeight: '700' },
  amount: { flexShrink: 1, alignItems: 'flex-end', gap: 4 },
  quantity: { color: color.text, fontSize: 20, lineHeight: 28, fontWeight: '800' },
  direction: { fontSize: 20, lineHeight: 27, fontWeight: '800' },
  footer: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: 8, borderTopWidth: 1, borderColor: color.border, paddingTop: 10 },
  small: { color: color.textDim, fontSize: 11, lineHeight: 17 }, notice: { color: color.accent, fontSize: 12, lineHeight: 18 },
  body: { color: color.text, fontSize: 14, lineHeight: 22 },
  detailTitle: { color: color.text, fontSize: 26, lineHeight: 34, fontWeight: '800' },
  address: { color: color.text, fontFamily: 'monospace', fontSize: 12, lineHeight: 20 },
});
