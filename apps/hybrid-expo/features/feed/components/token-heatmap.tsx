import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useFocusedAppStateInterval } from '@/hooks/useFocusedAppStateInterval';
import { FEED_COLORS as color } from '../feed.constants';
import { formatFeedUsd as usd } from '../feed-format';
import { formatHeatmapChange, heatmapColor, heatmapTone, layoutVolumeTreemap, type HeatmapTile } from '../token-heatmap-layout';
import { HEATMAP_INTERVALS, type HeatmapInterval, type HeatmapToken, type TokenHeatmapResult } from '../token-heatmap.types';
import { useTokenHeatmap } from '../use-token-heatmap';
import { FeedDetailSheet } from './feed-detail-sheet';
import { FeedSectionState } from './feed-section-state';

type Panel = { snapshot: TokenHeatmapResult; address: string | null; fromList: boolean };
const tint = { up: '#91DFBE', down: '#F8A5A5', neutral: color.textDim };

function timestamp(value: string | null) {
  if (!value) return '';
  return new Date(value).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
}

function tokenLabel(token: HeatmapToken, interval: HeatmapInterval) {
  return `${token.symbol}, ${token.name}, ${interval} price change ${formatHeatmapChange(token.priceChangePct)}, ${interval} volume ${usd(token.volumeUsd, true)}`;
}

function VolumeTile({ tile, interval, fontScale, onPress }: {
  tile: HeatmapTile; interval: HeatmapInterval; fontScale: number; onPress: () => void;
}) {
  const { token, width, height, x, y } = tile;
  const interactive = width >= 44 && height >= 44;
  const showText = width >= 56 * fontScale && height >= 48 * fontScale;
  const roomy = width >= 120 * fontScale && height >= 110 * fontScale;
  const style = [styles.tile, { left: x, top: y, width, height, backgroundColor: heatmapColor(token.priceChangePct) }];
  const content = showText ? <View pointerEvents="none" style={styles.tileCopy}>
    <Text accessible={false} numberOfLines={1} style={[styles.symbol, roomy && styles.largeSymbol]}>{token.symbol}</Text>
    <Text accessible={false} numberOfLines={1} style={[styles.tileChange, roomy && styles.largeChange]}>{formatHeatmapChange(token.priceChangePct)}</Text>
    {roomy ? <Text accessible={false} numberOfLines={1} style={styles.tileVolume}>{usd(token.volumeUsd, true)} vol</Text> : null}
  </View> : null;
  // Very small areas keep their true volume share. The full list gives every token a 44dp target.
  return interactive ? <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`View ${tokenLabel(token, interval)}`} style={style}>{content}</Pressable>
    : <View accessible={false} importantForAccessibility="no-hide-descendants" style={style}>{content}</View>;
}

export function TokenHeatmap({ active = true, refreshVersion = 0 }: { active?: boolean; refreshVersion?: number }) {
  const [interval, setInterval] = useState<HeatmapInterval>('24h');
  const [width, setWidth] = useState(0);
  const [panel, setPanel] = useState<Panel | null>(null);
  const { fontScale } = useWindowDimensions();
  const height = 320 * Math.max(1, Math.min(fontScale, 1.5));
  const section = useTokenHeatmap(interval, active);
  const previousRefresh = useRef(refreshVersion);
  useEffect(() => {
    if (previousRefresh.current === refreshVersion) return;
    previousRefresh.current = refreshVersion;
    if (active) void section.load();
  }, [active, refreshVersion, section.load]);
  useFocusedAppStateInterval(() => section.load(), 5 * 60_000, { enabled: active, resetKey: interval });
  const data = section.data;
  const expired = !!data?.fetchedAt && Date.now() - Date.parse(data.fetchedAt) > 30 * 60_000;
  const usable = !!data && data.status !== 'unavailable' && !expired;
  const tiles = useMemo(() => layoutVolumeTreemap(usable ? data.tokens : [], width, height), [data, usable, width, height]);
  const retryable = data?.error?.retryable !== false;
  const selected = panel?.snapshot.tokens.find((token) => token.address === panel.address);
  const closePanel = () => {
    if (panel?.address && panel.fromList) setPanel({ ...panel, address: null });
    else setPanel(null);
  };

  return <View style={styles.section}>
    <View style={styles.heading}>
      <Text accessibilityRole="header" style={styles.title}>Token heatmap</Text>
      <Pressable onPress={() => { void section.load(); }} disabled={!active || section.loading || !retryable}
        accessibilityRole="button" accessibilityLabel="Refresh token heatmap" accessibilityState={{ disabled: !active || section.loading || !retryable, busy: section.loading }} style={styles.actionButton}>
        <Text style={[styles.actionText, (section.loading || !retryable) && styles.dim]}>{section.loading && data ? 'Refreshing…' : 'Refresh'}</Text>
      </Pressable>
    </View>
    <Text selectable style={styles.description}>Jupiter-verified Solana tokens · excluding USDC / USDT</Text>
    <View style={styles.intervals}>
      {HEATMAP_INTERVALS.map((window) => <Pressable key={window} onPress={() => setInterval(window)}
        accessibilityRole="button" accessibilityLabel={`${window} token heatmap`} accessibilityState={{ selected: window === interval }}
        style={[styles.interval, window === interval && styles.selectedInterval]}>
        <Text style={[styles.intervalText, window === interval && styles.selectedIntervalText]}>{window}</Text>
      </Pressable>)}
    </View>
    <Text selectable style={styles.explanation}>Size: {interval} trading volume · Colour: price change</Text>

    <View style={[styles.content, { minHeight: height + 115 }]}>
    {section.loading && !data ? <FeedSectionState title={`Loading ${interval} token heatmap…`} loading /> : null}
    {section.error ? <FeedSectionState title="Heatmap refresh failed" text={usable ? `Showing the last loaded ${interval} values.` : 'Token market data could not be loaded.'} onRetry={() => { void section.load(); }} /> : null}
    {data?.status === 'unavailable' || expired ? <FeedSectionState title="Token heatmap unavailable" text={expired ? 'Saved token values have expired.' : 'Token market data is not available right now.'} onRetry={retryable ? () => { void section.load(); } : undefined} /> : null}
    {usable && !data.tokens.length ? <FeedSectionState title={data.partial ? 'Token values unavailable in this interval' : 'No trading volume in this interval'} text="Choose another interval or try again later." /> : null}
    {usable && data.tokens.length > 0 ? <>
      {data.stale || data.partial ? <Text selectable style={styles.notice}>{data.stale ? 'Showing saved data — live refresh is unavailable.' : 'Partial data — some token values are unavailable.'}</Text> : null}
      <View accessibilityLabel={`${interval} trading-volume treemap`} onLayout={(event) => setWidth(event.nativeEvent.layout.width)} style={[styles.map, { height }]}>
        {tiles.map((tile) => <VolumeTile key={tile.token.address} tile={tile} interval={interval} fontScale={fontScale}
          onPress={() => setPanel({ snapshot: data, address: tile.token.address, fromList: false })} />)}
      </View>
      <View style={styles.legend}>
        <View style={styles.legendItem}><View style={[styles.swatch, { backgroundColor: heatmapColor(-4) }]} /><Text style={styles.description}>Down</Text></View>
        <View style={styles.legendItem}><View style={[styles.swatch, { backgroundColor: heatmapColor(0) }]} /><Text style={styles.description}>Flat / unknown</Text></View>
        <View style={styles.legendItem}><View style={[styles.swatch, { backgroundColor: heatmapColor(4) }]} /><Text style={styles.description}>Up</Text></View>
      </View>
      <Pressable onPress={() => setPanel({ snapshot: data, address: null, fromList: true })} accessibilityRole="button" accessibilityLabel={`View all ${data.tokens.length} heatmap tokens`} style={styles.allTokens}>
        <Text style={styles.actionText}>View all {data.tokens.length} tokens →</Text>
      </Pressable>
      <Text selectable style={styles.source}>Jupiter · {timestamp(data.fetchedAt)} UTC{data.stale ? ' · Saved data' : ''}</Text>
    </> : null}
    </View>

    <FeedDetailSheet visible={!!panel} title={selected ? selected.symbol : `Solana tokens · ${panel?.snapshot.interval ?? interval}`} onClose={closePanel}>
      {panel && selected ? <>
        {panel.fromList ? <Pressable onPress={() => setPanel({ ...panel, address: null })} accessibilityRole="button" style={styles.actionButton}><Text style={styles.actionText}>← All tokens</Text></Pressable> : null}
        <Text selectable style={styles.tokenName}>{selected.name}</Text>
        <Text selectable style={styles.price}>{usd(selected.priceUsd)}</Text>
        <View style={styles.detailMetrics}>
          <Metric label={`${panel.snapshot.interval} price change`} value={formatHeatmapChange(selected.priceChangePct)} tint={tint[heatmapTone(selected.priceChangePct)]} />
          <Metric label={`${panel.snapshot.interval} trading volume`} value={usd(selected.volumeUsd, true)} />
          <Metric label="Market cap" value={usd(selected.marketCapUsd, true)} />
          <Metric label="Liquidity" value={usd(selected.liquidityUsd, true)} />
        </View>
        <Text selectable style={styles.source}>Solana token address</Text>
        <Text selectable style={styles.address}>{selected.address}</Text>
        <Text selectable style={styles.source}>Jupiter · {timestamp(panel.snapshot.fetchedAt)} UTC{panel.snapshot.stale ? ' · Saved data' : ''}</Text>
      </> : panel ? <>
        <Text selectable style={styles.description}>Ranked by {panel.snapshot.interval} trading volume. Tap a token for details.</Text>
        {panel.snapshot.tokens.map((token, index) => <Pressable key={token.address} onPress={() => setPanel({ ...panel, address: token.address, fromList: true })}
          accessibilityRole="button" accessibilityLabel={tokenLabel(token, panel.snapshot.interval)} style={styles.tokenRow}>
          <Text style={styles.rank}>{index + 1}</Text>
          <View style={styles.rowName}><Text numberOfLines={1} style={styles.rowSymbol}>{token.symbol}</Text><Text numberOfLines={1} style={styles.source}>{token.name}</Text></View>
          <View style={styles.rowValues}><Text style={[styles.rowChange, { color: tint[heatmapTone(token.priceChangePct)] }]}>{formatHeatmapChange(token.priceChangePct)}</Text><Text style={styles.source}>{usd(token.volumeUsd, true)} vol</Text></View>
        </Pressable>)}
        <Text selectable style={styles.source}>Jupiter · {timestamp(panel.snapshot.fetchedAt)} UTC{panel.snapshot.stale ? ' · Saved data' : ''}</Text>
      </> : null}
    </FeedDetailSheet>
  </View>;
}

function Metric({ label, value, tint = color.text }: { label: string; value: string; tint?: string }) {
  return <View style={styles.metric}><Text style={styles.source}>{label}</Text><Text selectable style={[styles.metricValue, { color: tint }]}>{value}</Text></View>;
}

const styles = StyleSheet.create({
  section: { gap: 12 },
  // Keep the parent Feed scroll offset stable when a new interval has no cached rows yet.
  content: { gap: 12 },
  heading: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  title: { color: color.text, fontSize: 22, fontWeight: '800', lineHeight: 29 },
  actionButton: { minHeight: 44, minWidth: 44, justifyContent: 'center', paddingHorizontal: 8 },
  actionText: { color: color.accent, fontSize: 12, fontWeight: '700', lineHeight: 19 },
  dim: { opacity: 0.5 },
  description: { color: color.textDim, fontSize: 12, lineHeight: 18 },
  explanation: { color: color.textDim, fontSize: 11, lineHeight: 17 },
  intervals: { flexDirection: 'row', gap: 4, backgroundColor: '#082D39', borderRadius: 8, padding: 4, borderWidth: 1, borderColor: color.border },
  interval: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 5, paddingHorizontal: 4 },
  selectedInterval: { backgroundColor: color.accent },
  intervalText: { color: color.textDim, fontSize: 13, fontWeight: '700' },
  selectedIntervalText: { color: '#082D39' },
  notice: { color: color.accent, fontSize: 12, lineHeight: 18 },
  map: { position: 'relative', overflow: 'hidden', backgroundColor: '#031F2C', borderRadius: 8 },
  tile: { position: 'absolute', borderWidth: 0.75, borderColor: '#082D39', overflow: 'hidden', justifyContent: 'center' },
  tileCopy: { padding: 7, gap: 4 },
  symbol: { color: '#FFFFFF', fontSize: 12, lineHeight: 16, fontWeight: '800' },
  largeSymbol: { fontSize: 25, lineHeight: 32 },
  tileChange: { color: '#FFFFFF', fontSize: 10, lineHeight: 14, fontWeight: '600', fontVariant: ['tabular-nums'] },
  largeChange: { fontSize: 17, lineHeight: 24 },
  tileVolume: { color: '#FFFFFF', fontSize: 11, lineHeight: 17, fontVariant: ['tabular-nums'] },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 14 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  swatch: { width: 9, height: 9, borderRadius: 2 },
  allTokens: { minHeight: 44, alignItems: 'center', justifyContent: 'center', borderColor: color.border, borderWidth: 1, borderRadius: 7 },
  source: { color: color.textDim, fontSize: 11, lineHeight: 17 },
  tokenName: { color: color.textDim, fontSize: 17, lineHeight: 24 },
  price: { color: color.text, fontSize: 32, lineHeight: 43, fontWeight: '800', fontVariant: ['tabular-nums'] },
  detailMetrics: { flexDirection: 'row', flexWrap: 'wrap', gap: 16 },
  metric: { minWidth: 125, flex: 1, gap: 5 },
  metricValue: { fontSize: 18, lineHeight: 25, fontWeight: '700', fontVariant: ['tabular-nums'] },
  address: { color: color.text, fontFamily: 'monospace', fontSize: 12, lineHeight: 20 },
  tokenRow: { minHeight: 56, flexDirection: 'row', gap: 10, alignItems: 'center', borderBottomWidth: 1, borderBottomColor: color.border, paddingVertical: 10 },
  rank: { width: 23, color: color.textFaint, fontSize: 12 },
  rowName: { flex: 1, minWidth: 0, gap: 3 },
  rowSymbol: { color: color.text, fontSize: 15, lineHeight: 21, fontWeight: '700' },
  rowValues: { alignItems: 'flex-end', gap: 3 },
  rowChange: { fontSize: 13, lineHeight: 19, fontWeight: '700', fontVariant: ['tabular-nums'] },
});
