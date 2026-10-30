import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { formatFeedUsd } from '../feed-format';
import { formatHeatmapChange, heatmapColor, layoutVolumeTreemap } from '../token-heatmap-layout';
import type { HeatmapInterval, HeatmapToken } from '../token-heatmap.types';

interface TokenTreemapProps {
  tokens: HeatmapToken[];
  height: number;
  interval: HeatmapInterval;
  onPressToken: (token: HeatmapToken) => void;
}

/**
 * Volume treemap shared by the Market slide (168 tall) and the Market screen
 * (220 tall) — issue #500. Same tile semantics as the full heatmap: area is
 * the token's volume share, colour the price change, tiles 44dp or larger are
 * tappable (they open the token sheet), text appears only when the tile fits
 * it at the current font scale.
 */
export function TokenTreemap({ tokens, height, interval, onPressToken }: TokenTreemapProps) {
  const [width, setWidth] = useState(0);
  const { fontScale } = useWindowDimensions();
  const tiles = useMemo(() => layoutVolumeTreemap(tokens, width, height), [tokens, width, height]);

  return (
    <View
      accessibilityLabel={`${interval} trading-volume treemap`}
      onLayout={(event) => {
        const next = event.nativeEvent.layout.width;
        if (next > 0 && next !== width) setWidth(next);
      }}
      style={[styles.map, { height }]}
    >
      {tiles.map((tile) => {
        const { token } = tile;
        const interactive = tile.width >= 44 && tile.height >= 44;
        const showText = tile.width >= 56 * fontScale && tile.height >= 48 * fontScale;
        const roomy = tile.width >= 120 * fontScale && tile.height >= 110 * fontScale;
        const content = showText ? (
          <View pointerEvents="none" style={styles.copy}>
            <Text accessible={false} numberOfLines={1} style={[styles.symbol, roomy && styles.largeSymbol]}>{token.symbol}</Text>
            <Text accessible={false} numberOfLines={1} style={[styles.change, roomy && styles.largeChange]}>{formatHeatmapChange(token.priceChangePct)}</Text>
          </View>
        ) : null;
        const tileStyle = [styles.tile, { left: tile.x, top: tile.y, width: tile.width, height: tile.height, backgroundColor: heatmapColor(token.priceChangePct) }];
        return interactive ? (
          <Pressable
            key={token.address}
            accessibilityRole="button"
            accessibilityLabel={`${token.symbol}, ${token.name}, ${interval} price change ${formatHeatmapChange(token.priceChangePct)}, ${interval} volume ${formatFeedUsd(token.volumeUsd, true)}`}
            onPress={() => onPressToken(token)}
            style={({ pressed }) => [tileStyle, pressed && styles.pressed]}
          >
            {content}
          </Pressable>
        ) : (
          <View key={token.address} accessible={false} style={tileStyle}>{content}</View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  map: {
    position: 'relative',
    overflow: 'hidden',
    backgroundColor: '#031F2C',
    borderRadius: 8,
  },
  tile: {
    position: 'absolute',
    borderWidth: 0.75,
    borderColor: '#082D39',
    overflow: 'hidden',
    justifyContent: 'center',
  },
  pressed: {
    opacity: 0.76,
  },
  copy: {
    padding: 7,
    gap: 4,
  },
  symbol: {
    color: '#FFFFFF',
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '800',
  },
  largeSymbol: {
    fontSize: 25,
    lineHeight: 32,
  },
  change: {
    color: '#FFFFFF',
    fontSize: 10,
    lineHeight: 14,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  largeChange: {
    fontSize: 17,
    lineHeight: 24,
  },
});