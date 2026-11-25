/**
 * Portfolio Map view body (issue #871, wallet.html at 02b98eba, frame
 * "Portfolio · Map"): the same top entries as the Table, drawn as a
 * treemap — one tile per entry, the tile's area is its share of the box,
 * placed by #870's `layoutPortfolioMap` inside a box as wide as the
 * Portfolio body and 260 high.
 *
 * The frame's `.tm` and `.tile` styles are the look: tiles butt on a 1px
 * border in the background colour with 7 padding; the name (12, weight 600)
 * sits at the top and — when the tile is wider than 70 and taller than 44,
 * the rule in `portfolio-map.tiles.ts` — the value (12 bold mono) and its
 * whole-percent share (10.5 dim mono) at the bottom; else the name only at
 * 10. Fills follow the frame's rank ladder (#0A4A60, #0A4A60, #083D50,
 * #083D50, #073B4C, #073B4C, #063343, repeating by placed rank); the
 * "Other N" tile is the --bg fill with a hairline edge and dim text, and
 * has no tap.
 *
 * Presentational only (like PortfolioCards): PortfolioSection picks the
 * entries, names and taps; this measures its width with onLayout and draws
 * the tiles. A failed app reaches this as no item at all, and a 0/negative
 * value (a Spot value unknown yet) is dropped by the layout — no tile.
 */

import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { semantic, tokens } from '@/theme';
import { layoutPortfolioMap } from '@/features/wallet/portfolio-map.layout';
import { portfolioMapTileText } from '@/features/wallet/portfolio-map.tiles';

/** The frame's `.tm` box: 260 high (the first-load skeleton matches it). */
const MAP_HEIGHT = 260;

export interface PortfolioMapItem {
  /** Stable tile id (app key, spot chain, or the Other tile's sentinel). */
  key: string;
  /** The name as the Table row shows it ("Spot · Solana", "Other N"). */
  name: string;
  /** USD value; the layout drops 0/negative/NaN, which then draws no tile. */
  valueUsd: number;
  /** The formatted value (`formatUsd`) for the detail line. */
  valueText: string;
  /** The "Other N" tile: --bg fill, hairline edge, dim text, no tap. */
  other: boolean;
  /** Pressable label; never read for the untappable Other tile. */
  accessibilityLabel: string;
  /** The Table row's tap handler; null keeps the tile untappable. */
  onPress: (() => void) | null;
}

/** The frame's `sh` ladder in drawMaps: by placed rank, largest first, repeating. */
const TILE_SHADES = ['#0A4A60', '#0A4A60', '#083D50', '#083D50', '#073B4C', '#073B4C', '#063343'];

export function PortfolioMap({
  items,
  totalUsd,
}: {
  items: readonly PortfolioMapItem[];
  totalUsd: number;
}) {
  const [width, setWidth] = useState(0);
  const byKey = useMemo(() => new Map(items.map((item) => [item.key, item])), [items]);
  const tiles = useMemo(
    () =>
      layoutPortfolioMap(
        items.map((item) => ({ id: item.key, valueUsd: item.valueUsd })),
        width,
        MAP_HEIGHT,
      ),
    [items, width],
  );

  return (
    <View
      accessibilityLabel="Portfolio map"
      onLayout={(event) => {
        const next = event.nativeEvent.layout.width;
        if (next > 0 && next !== width) setWidth(next);
      }}
      style={{ height: MAP_HEIGHT }}
    >
      {tiles.map((tile, index) => {
        const item = byKey.get(tile.id);
        if (!item) return null;
        const { detail, percent } = portfolioMapTileText(
          tile.width,
          tile.height,
          item.valueUsd,
          totalUsd,
        );
        const copy = (
          <>
            <Text
              numberOfLines={1}
              style={[item.other ? styles.nameDim : styles.name, !detail && styles.nameSmall]}
            >
              {item.name}
            </Text>
            {detail ? (
              <Text>
                <Text style={item.other ? styles.valueDim : styles.value}>{item.valueText}</Text>
                <Text style={styles.percent}>{` ${percent}%`}</Text>
              </Text>
            ) : null}
          </>
        );
        const tileStyle = [
          styles.tile,
          {
            left: tile.x,
            top: tile.y,
            width: tile.width,
            height: tile.height,
            backgroundColor: item.other ? styles.otherFill.backgroundColor : TILE_SHADES[index % TILE_SHADES.length],
          },
          item.other && styles.otherTile,
        ];
        return item.onPress === null ? (
          <View key={`tile:${tile.id}`} accessible={false} style={tileStyle}>
            {copy}
          </View>
        ) : (
          <Pressable
            key={`tile:${tile.id}`}
            accessibilityRole="button"
            accessibilityLabel={item.accessibilityLabel}
            onPress={item.onPress}
            style={({ pressed }) => [tileStyle, pressed && styles.pressed]}
          >
            {copy}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  tile: {
    position: 'absolute',
    borderWidth: 1,
    borderColor: tokens.colors.walletCore,
    padding: 7,
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    overflow: 'hidden',
  },
  pressed: { opacity: 0.82 },
  name: { color: semantic.text.primary, fontSize: 12, fontWeight: '600', lineHeight: 15 },
  nameSmall: { fontSize: 10, lineHeight: 13 },
  nameDim: { color: semantic.text.dim },
  value: { color: semantic.text.primary, fontFamily: 'monospace', fontSize: 12, fontWeight: '700', lineHeight: 14 },
  valueDim: { color: semantic.text.dim, fontFamily: 'monospace', fontSize: 12, fontWeight: '700', lineHeight: 14 },
  percent: { color: semantic.text.dim, fontFamily: 'monospace', fontSize: 10.5 },
  // The frame's `.tile.other`: --bg fill with the hairline edge carrying the
  // shape (the 1px --bg border that separates ordinary tiles is invisible on
  // this fill), text dim.
  otherFill: { backgroundColor: tokens.colors.walletCore },
  otherTile: { borderColor: semantic.border.muted },
});
