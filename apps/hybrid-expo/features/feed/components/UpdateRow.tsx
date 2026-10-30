import { Pressable, StyleSheet, Text } from 'react-native';
import { FEED_TOKENS, monoFontFamily } from '@/features/feed/feed-design';
import { updateMeta } from '@/features/feed/feed-updates';
import type { FeedItem } from '@/features/feed/feed.types';

interface UpdateRowProps {
  item: FeedItem;
  now: Date;
  onPress: (item: FeedItem) => void;
}

/**
 * Text-only "All updates" row (issue #496, DESIGN.md §7 + feed-mock.html
 * #s-allupdates): boxed card, title first, one-line summary, mono-cap meta.
 * No image. The whole card is tappable and opens the news sheet.
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
      {item.description ? <Text style={styles.description} numberOfLines={1}>{item.description}</Text> : null}
      <Text style={styles.meta}>{updateMeta(item, now)}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    minHeight: 44,
    borderRadius: FEED_TOKENS.radius.card,
    borderWidth: 1,
    borderColor: FEED_TOKENS.colors.border,
    backgroundColor: FEED_TOKENS.colors.card,
    padding: FEED_TOKENS.space.md,
    marginBottom: FEED_TOKENS.space.md,
    gap: FEED_TOKENS.space.sm,
  },
  title: {
    color: FEED_TOKENS.colors.text,
    fontSize: FEED_TOKENS.type.cardTitle,
    lineHeight: 23,
    fontWeight: '600',
  },
  description: {
    color: FEED_TOKENS.colors.textDim,
    fontSize: FEED_TOKENS.type.body,
    lineHeight: 20,
  },
  meta: {
    color: FEED_TOKENS.colors.textFaint,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    lineHeight: 14,
    fontWeight: '600',
    letterSpacing: 1,
  },
  pressed: {
    opacity: 0.78,
  },
});