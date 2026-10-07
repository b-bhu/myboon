import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { fetchSpotTokens, searchSpotTokens, SpotApiError, type SpotTokenSummary } from '@/features/spot/spot.api';
import { useFocusedAppStateInterval } from '@/hooks/useFocusedAppStateInterval';
import { FEED_COLORS as color } from '../feed.constants';
import { useFeedSection } from '../use-feed-section';
import { FeedSectionState } from './feed-section-state';
import { formatFeedUsd as usd } from '../feed-format';
import { selectedToken } from '../feed-state';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const WINDOWS = { m5: '5m', h1: '1h', h6: '6h', h24: '24h' } as const;
async function loadTokens(signal: AbortSignal) {
  const [sol, trending] = await Promise.allSettled([searchSpotTokens(SOL_MINT, { signal }), fetchSpotTokens(8, { signal })]);
  if (sol.status === 'rejected' && trending.status === 'rejected') throw sol.reason;
  const rows = new Map<string, SpotTokenSummary>();
  if (sol.status === 'fulfilled') sol.value.items.forEach((item) => rows.set(item.identity.key, item));
  if (trending.status === 'fulfilled') trending.value.items.forEach((item) => rows.set(item.identity.key, item));
  return { items: [...rows.values()], partial: sol.status === 'rejected' || trending.status === 'rejected'
    || (sol.status === 'fulfilled' && sol.value.partial) || (trending.status === 'fulfilled' && trending.value.partial),
    asOf: sol.status === 'fulfilled' ? sol.value.asOf : trending.status === 'fulfilled' ? trending.value.asOf : '' };
}
export function TokenStats({ active = true }: { active?: boolean }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [window, setWindow] = useState<keyof typeof WINDOWS>('h24');
  const [retryable, setRetryable] = useState(true);
  const fetcher = useCallback(async (signal: AbortSignal) => {
    try {
      const result = await loadTokens(signal);
      if (!signal.aborted) setRetryable(true);
      return result;
    } catch (error) {
      if (!signal.aborted) setRetryable(!(error instanceof SpotApiError) || error.retryable);
      throw error;
    }
  }, []);
  const section = useFeedSection(fetcher, active);
  useFocusedAppStateInterval(() => section.load(), 60_000, { enabled: active });
  const item = selectedToken(section.data?.items ?? [], selected);
  const change = item?.momentumPct[window] ?? null;
  return <View style={styles.section}>
    <Text accessibilityRole="header" style={styles.title}>Token stats</Text>
    {section.loading && !section.data ? <FeedSectionState title="Loading token stats…" loading /> : null}
    {section.error ? <FeedSectionState title={section.data ? 'Token stats refresh failed' : 'Token stats unavailable'} text={section.data ? 'Showing the last loaded values.' : 'Prices and market data could not be loaded.'} onRetry={retryable ? () => { void section.load(); } : undefined} /> : null}
    {section.data && !item ? <>
      <FeedSectionState title={selected ? 'Selected token unavailable' : 'Token stats unavailable'} text={selected ? 'This token is no longer in the available data.' : 'No supported tokens were returned.'} onRetry={retryable ? () => { void section.load(); } : undefined} />
      {selected ? <Pressable onPress={() => setSelected(null)} accessibilityRole="button" style={styles.option}><Text style={styles.optionText}>Show available tokens</Text></Pressable> : null}
    </> : null}
    {item ? <View style={styles.card}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.options}>
        {section.data?.items.map((row) => <Pressable key={row.identity.key} onPress={() => setSelected(row.identity.key)} accessibilityRole="button" accessibilityLabel={`Token stats for ${row.identity.symbol}, ${row.identity.name}`} accessibilityState={{ selected: row.identity.key === item.identity.key }} style={[styles.option, row.identity.key === item.identity.key && styles.selected]}><Text style={styles.optionText}>{row.identity.symbol}</Text></Pressable>)}
      </ScrollView>
      <View style={styles.priceRow}><View style={{ flex: 1 }}><Text style={styles.name}>{item.identity.name}</Text><Text selectable style={styles.price}>{usd(item.usdPrice)}</Text></View><View><Text style={styles.label}>{WINDOWS[window]} change</Text><Text selectable style={[styles.change, { color: change === null ? color.textDim : change >= 0 ? '#91DFBE' : '#F8A5A5' }]}>{change === null ? 'Unavailable' : `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`}</Text></View></View>
      <View style={styles.options}>{(Object.keys(WINDOWS) as (keyof typeof WINDOWS)[]).map((key) => <Pressable key={key} onPress={() => setWindow(key)} accessibilityRole="button" accessibilityLabel={`${WINDOWS[key]} token change`} accessibilityState={{ selected: window === key }} style={[styles.window, window === key && styles.selected]}><Text style={styles.optionText}>{WINDOWS[key]}</Text></Pressable>)}</View>
      <View style={styles.metrics}>{[
        ['Market cap', item.market.marketCapUsd], ['Liquidity', item.market.liquidityUsd], ['24h volume', item.market.volume24hUsd],
      ].map(([label, value]) => <View key={String(label)} style={styles.metric}><Text style={styles.label}>{label}</Text><Text selectable style={styles.value}>{usd(typeof value === 'number' ? value : null, true)}</Text></View>)}</View>
      <Text selectable style={styles.label}>Jupiter · Solana · {new Date(item.updatedAt ?? section.data!.asOf).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC{section.data?.partial ? ' · Partial data' : ''}</Text>
      {item.warnings.suspicious || item.warnings.verification === 'unverified' ? <Text style={styles.label}>Unverified token data</Text> : null}
    </View> : null}
  </View>;
}
const styles = StyleSheet.create({
  section: { gap: 12 }, title: { color: color.text, fontSize: 22, fontWeight: '800', lineHeight: 29 },
  card: { padding: 14, gap: 16, backgroundColor: '#031F2C', borderRadius: 9, borderWidth: 1, borderColor: color.border },
  options: { flexDirection: 'row', gap: 6 }, option: { minWidth: 52, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 6, paddingHorizontal: 12 },
  selected: { backgroundColor: color.cardActive, borderColor: color.border, borderWidth: 1 }, optionText: { color: color.text, fontSize: 12, fontWeight: '700' },
  priceRow: { flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  name: { color: color.textDim, fontSize: 13, lineHeight: 19 }, price: { color: color.text, fontSize: 30, fontWeight: '800', fontVariant: ['tabular-nums'] },
  change: { fontSize: 19, fontWeight: '700', paddingTop: 4 }, label: { color: color.textDim, fontSize: 10, lineHeight: 16 },
  window: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 5 },
  metrics: { flexDirection: 'row', flexWrap: 'wrap', gap: 16 }, metric: { minWidth: 90, flex: 1, gap: 4 }, value: { color: color.text, fontSize: 16, fontWeight: '700' },
});
