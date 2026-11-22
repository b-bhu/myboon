/**
 * PairPanel — the shared Swap and Move two-column layout: a column header
 * with a chain dial, a 231px asset list, and a gold wire joining the two
 * selected rows (#732). Everything arrives as props — column labels, the
 * chain list, the assets for the selected chain, both selections and the
 * change callbacks — so Move can later pass "From"/"To" and places where
 * Swap passes "Pay"/"Receive" and tokens. Nothing here hard-codes those
 * names and nothing here knows what a token is.
 *
 * Not mounted in the Wallet screen yet; Swap keeps today's composer. Sizing
 * lives in ./pair-panel-geometry (lists 231px per the wiki, D54 — not the
 * mock's older 258px rule).
 *
 * Design: https://github.com/b-bhu/myboon/blob/37e0a5187cbc8510610a9e437ac4dbf4555885f7/docs/design/wallet.html
 * (mock `clamp`, dial `Math.round(cur / DW) * DW` snap and `seeSelected`).
 */

import { Image } from 'expo-image';
import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { LayoutChangeEvent } from 'react-native';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, Path, Rect, Stop } from 'react-native-svg';
import { tokens } from '@/theme';
import {
  centredDialIndex,
  dialCentredOffsetPx,
  DIAL_FADE_PX,
  DIAL_HEIGHT_PX,
  DIAL_ITEM_PX,
  DIAL_SIDE_PAD_PX,
  DIAL_WIDTH_PX,
  HEADER_HEIGHT_PX,
  LIST_HEIGHT_PX,
  ROW_GAP_PX,
  ROW_HEIGHT_PX,
  listTopForIndex,
  rowCentreY,
  WIRE_GUTTER_PX,
  wireAnchorY,
} from './pair-panel-geometry';

// The locked action-panel palette (same values features/swap's composer uses);
// kept literal here so PairPanel stays free of swap-specific module imports.
const color = {
  gold: tokens.colors.primaryDim,
  navy: tokens.colors.walletCore,
  card: tokens.colors.surface,
  text: tokens.colors.bone,
  dim: tokens.colors.textDim,
  border: tokens.colors.borderMuted,
} as const;

export interface PairChainOption {
  id: string;
  /** Shown under the column label and as the dial's accessibility label. */
  name: string;
  /** Dial icon; iconless chains fall back to their initial letter. */
  iconUri?: string | null;
}

export interface PairAssetOption {
  id: string;
  /** Accessibility label; rendered as text only when no icon works. */
  name: string;
  /** Row icon ("no ticker text where an icon works"); null falls back to text. */
  iconUri?: string | null;
}

/** One column: label, chains, that side's selection and its callbacks. */
export interface PairSideProps {
  label: string;
  chains: PairChainOption[];
  selectedChainId: string;
  /** Assets for the selected chain, as provided by the caller. */
  assets: PairAssetOption[];
  selectedAssetId: string | null;
  onChainChange?: (chainId: string) => void;
  onAssetChange?: (assetId: string) => void;
}

export interface PairPanelProps {
  left: PairSideProps;
  right: PairSideProps;
  /** Surface colour behind the dial's edge fade and the wire's node core —
   * the locked action-panel body colour unless stated otherwise. */
  fadeColor?: string;
}

/** A badge mark: icon when one exists, else the label's initial. */
function OptionMark({ uri, label, size, ringed }: {
  uri?: string | null;
  label: string;
  size: number;
  ringed: boolean;
}) {
  return (
    <View style={[styles.mark, { width: size, height: size, borderRadius: size / 2 }, ringed && styles.markRing]}>
      {uri ? (
        <Image source={uri} style={styles.markImage} contentFit="cover" />
      ) : (
        <Text style={[styles.markLetter, { fontSize: Math.max(8, size * 0.55) }]}>{label.slice(0, 1).toUpperCase()}</Text>
      )}
    </View>
  );
}

/** The 100x34 chain dial: drag and it snaps so the centred chain is selected. */
function ChainDial({ chains, selectedId, onSelect, fadeColor }: {
  chains: PairChainOption[];
  selectedId: string;
  onSelect?: (id: string) => void;
  fadeColor: string;
}) {
  const dialRef = useRef<ScrollView>(null);
  const dragging = useRef(false);
  const idx = chains.findIndex((chain) => chain.id === selectedId);

  // Resting dial: keep the selected chain centred (mock `scrollLeft = idx * DW`).
  useEffect(() => {
    if (idx >= 0 && !dragging.current) dialRef.current?.scrollTo({ x: dialCentredOffsetPx(idx), animated: false });
  }, [idx]);

  return (
    <View style={styles.dial}>
      <ScrollView
        ref={dialRef}
        horizontal
        style={styles.dialScroll}
        contentContainerStyle={styles.dialTrack}
        showsHorizontalScrollIndicator={false}
        snapToInterval={DIAL_ITEM_PX}
        scrollEventThrottle={16}
        onScrollBeginDrag={() => { dragging.current = true; }}
        onScrollEndDrag={() => { dragging.current = false; }}
        onMomentumScrollEnd={() => { dragging.current = false; }}
        onScroll={(event) => {
          // Live selection: the centred chain counts, even mid-drag (mock dialV).
          if (!dragging.current) return;
          const chain = chains[centredDialIndex(event.nativeEvent.contentOffset.x, chains.length)];
          if (chain && chain.id !== selectedId) onSelect?.(chain.id);
        }}
      >
        {chains.map((chain, i) => (
          <Pressable
            key={chain.id}
            accessibilityRole="button"
            accessibilityLabel={chain.name}
            onPress={() => onSelect?.(chain.id)}
            style={[styles.dialItem, i === idx && styles.markOpacityOn]}
          >
            <OptionMark uri={chain.iconUri} label={chain.name} size={i === idx ? 26 : 20} ringed={i === idx} />
          </Pressable>
        ))}
      </ScrollView>
      <Svg width={DIAL_WIDTH_PX} height={DIAL_HEIGHT_PX} style={styles.dialChrome} pointerEvents="none">
        <Defs>
          <LinearGradient id="fadeIn" x1="0" y1="0" x2={DIAL_FADE_PX} y2="0">
            <Stop offset="0" stopColor={fadeColor} stopOpacity="0" />
            <Stop offset="1" stopColor={fadeColor} stopOpacity="1" />
          </LinearGradient>
          <LinearGradient id="fadeOut" x1={DIAL_WIDTH_PX - DIAL_FADE_PX} y1="0" x2={DIAL_WIDTH_PX} y2="0">
            <Stop offset="0" stopColor={fadeColor} stopOpacity="1" />
            <Stop offset="1" stopColor={fadeColor} stopOpacity="0" />
          </LinearGradient>
        </Defs>
        <Rect width={DIAL_FADE_PX} height={DIAL_HEIGHT_PX} fill="url(#fadeIn)" />
        <Rect x={DIAL_WIDTH_PX - DIAL_FADE_PX} width={DIAL_FADE_PX} height={DIAL_HEIGHT_PX} fill="url(#fadeOut)" />
        {/* Gold mark at the centre (mock `.dial:after`: 14x2 on the bottom edge). */}
        <Rect x={(DIAL_WIDTH_PX - 14) / 2} y={DIAL_HEIGHT_PX - 2} width={14} height={2} fill={color.gold} />
      </Svg>
    </View>
  );
}

/** A 231px scrolling asset list; the selected row is highlighted. */
function AssetList({
  assets,
  selectedAssetId,
  onSelect,
  onScroll,
  listRef,
}: {
  assets: PairAssetOption[];
  selectedAssetId: string | null;
  onSelect?: (assetId: string) => void;
  onScroll: (scrollTopPx: number) => void;
  listRef: RefObject<ScrollView | null>;
}) {
  const idx = assets.findIndex((asset) => asset.id === selectedAssetId);

  // Mock `seeSelected`: bring a changed selection into view (row top − 44).
  // Depends on the index and the list length, not the `assets` array, so a
  // live balance refresh (new array identity, same rows) doesn't snap the list.
  useEffect(() => {
    if (idx >= 0) listRef.current?.scrollTo({ y: listTopForIndex(idx), animated: false });
  }, [idx, assets.length, listRef]);

  return (
    <ScrollView
      ref={listRef}
      style={styles.list}
      contentContainerStyle={styles.listContent}
      showsVerticalScrollIndicator={false}
      scrollEventThrottle={16}
      onScroll={(event) => onScroll(Math.round(event.nativeEvent.contentOffset.y))}
    >
      {assets.map((asset) => (
        <Pressable
          key={asset.id}
          accessibilityRole="button"
          accessibilityLabel={asset.name}
          accessibilityState={{ selected: asset.id === selectedAssetId }}
          onPress={() => onSelect?.(asset.id)}
          style={[styles.row, asset.id === selectedAssetId && styles.rowOn]}
        >
          <OptionMark uri={asset.iconUri} label={asset.name} size={24} ringed={false} />
          {/* No ticker text where an icon works. */}
          {!asset.iconUri && <Text style={styles.rowName} numberOfLines={1}>{asset.name}</Text>}
        </Pressable>
      ))}
    </ScrollView>
  );
}

export function PairPanel({ left, right, fadeColor = color.navy }: PairPanelProps) {
  const [band, setBand] = useState<{ width: number; height: number } | null>(null);
  const [leftWidth, setLeftWidth] = useState(0);
  const [scroll, setScroll] = useState({ left: 0, right: 0 });
  const leftListRef = useRef<ScrollView>(null);
  const rightListRef = useRef<ScrollView>(null);

  const leftIdx = left.assets.findIndex((asset) => asset.id === left.selectedAssetId);
  const rightIdx = right.assets.findIndex((asset) => asset.id === right.selectedAssetId);
  // Wire and node from the selected rows; each end clamps to its list's edge
  // when that row scrolls out of view. No selection on a side, no wire.
  const wire = band && leftWidth > 0 && leftIdx >= 0 && rightIdx >= 0
    ? {
        width: band.width,
        height: band.height,
        x1: leftWidth,
        x2: leftWidth + WIRE_GUTTER_PX,
        y1: HEADER_HEIGHT_PX + wireAnchorY(rowCentreY(leftIdx, scroll.left)),
        y2: HEADER_HEIGHT_PX + wireAnchorY(rowCentreY(rightIdx, scroll.right)),
      }
    : null;

  const column = (side: 'left' | 'right', props: PairSideProps, listRef: RefObject<ScrollView | null>, onLayout?: (event: LayoutChangeEvent) => void) => (
    <View style={styles.column} onLayout={onLayout}>
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.headerLabel} numberOfLines={1}>{props.label}</Text>
          <Text style={styles.headerChain} numberOfLines={1}>
            {props.chains.find((chain) => chain.id === props.selectedChainId)?.name ?? ''}
          </Text>
        </View>
        <ChainDial
          chains={props.chains}
          selectedId={props.selectedChainId}
          onSelect={props.onChainChange}
          fadeColor={fadeColor}
        />
      </View>
      <AssetList
        assets={props.assets}
        selectedAssetId={props.selectedAssetId}
        onSelect={props.onAssetChange}
        onScroll={(scrollTopPx) => setScroll((state) => ({ ...state, [side]: scrollTopPx }))}
        listRef={listRef}
      />
    </View>
  );

  return (
    <View style={styles.panel} testID="pair-panel">
      <View
        style={styles.rowBand}
        onLayout={(event) => setBand({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height })}
      >
        {column('left', left, leftListRef, (event) => setLeftWidth(event.nativeEvent.layout.width))}
        <View style={styles.gutter} />
        {column('right', right, rightListRef)}
        {wire && (
          <Svg width={wire.width} height={wire.height} style={styles.wires} pointerEvents="none">
            <Path
              d={`M ${wire.x1} ${wire.y1} C ${(wire.x1 + wire.x2) / 2} ${wire.y1}, ${(wire.x1 + wire.x2) / 2} ${wire.y2}, ${wire.x2} ${wire.y2}`}
              stroke={color.gold}
              strokeWidth={1.6}
              fill="none"
            />
            {/* Node on the join (mock `.node`, 22px with a gold ring; its flip
            action is not part of this issue's props, so it stays decorative). */}
            <Circle cx={(wire.x1 + wire.x2) / 2} cy={(wire.y1 + wire.y2) / 2} r={11} fill={color.navy} stroke={color.gold} strokeWidth={1.5} />
            <Circle cx={(wire.x1 + wire.x2) / 2} cy={(wire.y1 + wire.y2) / 2} r={3} fill={color.gold} />
          </Svg>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { flexShrink: 1, minHeight: 0 },
  rowBand: { position: 'relative', flexDirection: 'row', minHeight: 0 },
  column: { flex: 1, minWidth: 0 },
  gutter: { width: WIRE_GUTTER_PX },
  header: { height: HEADER_HEIGHT_PX, flexDirection: 'row', alignItems: 'center', gap: 4 },
  headerText: { flex: 1, minWidth: 0, gap: 2 },
  headerLabel: { fontSize: 13, fontWeight: '600', color: color.text },
  // Chain name under the label: mono 10, letterspaced, gold (mock `.ch-t small`).
  headerChain: { fontSize: 10, fontFamily: 'monospace', letterSpacing: 0.6, textTransform: 'uppercase', color: color.gold },
  dial: { width: DIAL_WIDTH_PX, height: DIAL_HEIGHT_PX, overflow: 'hidden' },
  dialScroll: { width: DIAL_WIDTH_PX, height: DIAL_HEIGHT_PX },
  dialTrack: { paddingHorizontal: DIAL_SIDE_PAD_PX },
  dialItem: { width: DIAL_ITEM_PX, height: 32, alignItems: 'center', justifyContent: 'center', opacity: 0.4 },
  markOpacityOn: { opacity: 1 },
  dialChrome: { position: 'absolute', left: 0, top: 0 },
  list: { height: LIST_HEIGHT_PX },
  listContent: { gap: ROW_GAP_PX },
  row: { height: ROW_HEIGHT_PX, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 6, borderRadius: 8 },
  // Selected row: gold 1.5 inset plus #FFD16618 (mock `.mv-row.on`).
  rowOn: { borderWidth: 1.5, borderColor: color.gold, backgroundColor: 'rgba(255,209,102,0.09)' },
  rowName: { fontSize: 13, fontWeight: '600', color: color.text },
  wires: { position: 'absolute', left: 0, top: 0 },
  mark: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden', backgroundColor: color.card },
  markImage: { width: '100%', height: '100%' },
  markLetter: { color: color.dim },
  markRing: { borderWidth: 1.5, borderColor: color.gold },
});
