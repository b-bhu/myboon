/**
 * Portfolio Cards view (issue #842, wallet.html at 02b98eba, frame
 * "Portfolio · Cards"): the same list as the Table, three cards across —
 * name, value, and under the value a small P&L chip when the app has one.
 * Presentational only: PortfolioSection decides the rows, the dust cut, the
 * top five, and where a tap goes; this just draws them.
 */

import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { semantic, tokens } from '@/theme';

export interface PortfolioCardItem {
  key: string;
  name: string;
  /** Brand colour of the name, as in the Table rows. */
  color: string;
  state: 'ok' | 'stale' | 'error';
  /** Formatted value; ignored for `error`, which shows a dash. */
  value: string;
  /** Small chip under the value, e.g. "+$18.00"; null shows none. */
  chip: string | null;
  chipNegative: boolean;
  /** Stale only: how old the held value is, shown where the chip would be. */
  age: string;
  accessibilityLabel: string;
  onOpen: () => void;
  onRetry: () => void;
  /** Spinner while a failed card's retry runs, else null. */
  spinner: ReactNode;
}

export function PortfolioCards({
  items,
  skeleton,
  moreCount,
  moreValue,
  onShowAll,
}: {
  items: readonly PortfolioCardItem[];
  /** First load in flight: five placeholder cards, nothing spinning (#858). */
  skeleton: boolean;
  moreCount: number;
  moreValue: string;
  onShowAll: () => void;
}) {
  return (
    <View style={styles.grid}>
      {skeleton
        ? ['a', 'b', 'c', 'd', 'e'].map((key) => (
          <View key={key} style={styles.cell}>
            <View style={styles.card}>
              <View style={[styles.skelIcon, styles.skeleton]} />
              <View style={[styles.skelName, styles.skeleton]} />
              <View style={[styles.skelValue, styles.skeleton]} />
            </View>
          </View>
        ))
        : items.map((item) => (
          <View key={item.key} style={styles.cell}>
            <View style={styles.card}>
              <Pressable
                disabled={item.state === 'error'}
                onPress={item.onOpen}
                accessibilityRole="button"
                accessibilityLabel={item.accessibilityLabel}
                style={({ pressed }) => [styles.body, pressed && styles.pressed]}
              >
                <Text numberOfLines={1} style={[styles.name, { color: item.color }]}>{item.name}</Text>
                <Text style={[styles.value, item.state !== 'ok' && styles.dimValue]}>
                  {item.state === 'error' ? '—' : item.value}
                </Text>
                {item.state === 'ok' && item.chip !== null ? (
                  <Text style={[styles.chip, item.chipNegative ? styles.chipDown : styles.chipUp]}>{item.chip}</Text>
                ) : null}
                {item.state === 'stale' ? <Text style={styles.age}>{item.age}</Text> : null}
              </Pressable>
              {item.state === 'ok' ? null : (
                <View style={styles.retryRow}>
                  {item.spinner}
                  <Pressable
                    onPress={item.onRetry}
                    accessibilityRole="button"
                    accessibilityLabel={`Retry ${item.name}`}
                    hitSlop={8}
                    style={({ pressed }) => pressed && styles.pressed}
                  >
                    <Text style={styles.retryLabel}>Retry</Text>
                  </Pressable>
                </View>
              )}
            </View>
          </View>
        ))}
      {!skeleton && moreCount > 0 ? (
        <View style={styles.cell}>
          <Pressable
            onPress={onShowAll}
            accessibilityRole="button"
            accessibilityLabel={`Show all ${items.length + moreCount} cards`}
            style={({ pressed }) => [styles.card, styles.moreCard, pressed && styles.pressed]}
          >
            <Text style={styles.moreLabel}>{`+${moreCount} more`}</Text>
            <Text style={styles.moreValue}>{moreValue}</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // The frame's .grid3 (3 columns, gap 8): thirds with 4px cell padding and
  // a matching negative margin, since RN has no grid gap in percentages.
  grid: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -4 },
  cell: { width: '33.3333%', padding: 4 },
  // .card3: card fill, hairline edge, radius 12, padding 10, min-height 96.
  card: {
    flex: 1,
    minHeight: 96,
    gap: 6,
    padding: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    backgroundColor: semantic.background.surface,
  },
  body: { gap: 6 },
  pressed: { opacity: 0.82 },
  name: { fontSize: 12.5, fontWeight: '800' },
  value: { color: semantic.text.primary, fontFamily: 'monospace', fontSize: 13, fontWeight: '800' },
  dimValue: { opacity: 0.65 },
  chip: { fontFamily: 'monospace', fontSize: 11 },
  chipUp: { color: semantic.sentiment.positive },
  chipDown: { color: semantic.sentiment.negative },
  age: { color: semantic.text.faint, fontFamily: 'monospace', fontSize: 11 },
  retryRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 'auto' },
  retryLabel: {
    color: tokens.colors.primary,
    fontFamily: 'monospace',
    fontSize: 10,
    fontWeight: '800',
    textDecorationLine: 'underline',
  },
  moreCard: { justifyContent: 'space-between' },
  moreLabel: { color: semantic.text.faint, fontSize: 12 },
  moreValue: { color: semantic.text.faint, fontFamily: 'monospace', fontSize: 13, fontWeight: '800' },
  skeleton: { backgroundColor: semantic.background.lift },
  skelIcon: { width: 26, height: 26, borderRadius: 6 },
  skelName: { width: 64, height: 10, borderRadius: 4 },
  skelValue: { width: 40, height: 12, borderRadius: 4 },
});
