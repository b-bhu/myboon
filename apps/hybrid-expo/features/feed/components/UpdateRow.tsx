import { Pressable, StyleSheet, Text } from 'react-native';
import { FEED_TOKENS, monoFontFamily } from '@/features/feed/feed-design';
import { summaryLine, updateMeta } from '@/features/feed/feed-updates';
import type { FeedItem } from '@/features/feed/feed.types';

interface UpdateRowProps {
  item: FeedItem;
  now: Date;
  onPress: (item: FeedItem) => void;
}

/**
 * Bordered "All updates" card (docs/design/feed.html #s-allupdates, issue
 * #797): #063343 fill inside a 1px #185A70 border, title first, one-line
 * summary ending on a whole word, mono-cap meta. No image. The whole card is
 * tappable and opens the news sheet.
 */
export function UpdateRowCard({ item, now, onPress }: UpdateRowProps) {
  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
      onPress={() => onPress(item)}
      accessibilityRole="button"
      accessibilityLabel={item.headline}
    >
      <Text style={styles.title} numberOfLines={3}>{item.headline}</Text>
      {item.description ? <Text style={styles.description} numberOfLines={1}>{summaryLine(item.description)}</Text> : null}
      <Text style={styles.meta}>{updateMeta(item, now)}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: FEED_TOKENS.colors.ground,
    borderRadius: FEED_TOKENS.radius.card,
    borderWidth: 1,
    borderColor: FEED_TOKENS.colors.border,
    padding: FEED_TOKENS.space.md,
    marginBottom: FEED_TOKENS.space.sm,
    gap: FEED_TOKENS.space.xs,
    minHeight: 44,
  },
  title: {
    color: FEED_TOKENS.colors.text,
    fontSize: FEED_TOKENS.type.cardTitle,
    lineHeight: 23,
    fontWeight: '700',
  },
  description: {
    color: FEED_TOKENS.colors.textDim,
    fontSize: FEED_TOKENS.type.body,
    lineHeight: 21,
    marginTop: 2,
  },
  meta: {
    color: FEED_TOKENS.colors.textFaint,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    lineHeight: 14,
    fontWeight: '600',
    letterSpacing: 1,
    marginTop: 2,
  },
  pressed: {
    opacity: 0.78,
  },
});
