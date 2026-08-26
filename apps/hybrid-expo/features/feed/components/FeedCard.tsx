import { Image } from 'expo-image';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { FEED_COLORS } from '@/features/feed/feed.constants';
import { toRelativeTime } from '@/features/feed/feed.api';
import type { FeedItem } from '@/features/feed/feed.types';

interface FeedCardProps {
  item: FeedItem;
  onPress: (item: FeedItem) => void;
}

export function FeedCard({ item, onPress }: FeedCardProps) {
  const date = toRelativeTime(item.createdAt);
  const hasContentImage = item.imageKind === 'content' && Boolean(item.imageUrl);
  const category = item.category === 'feed' ? 'Latest' : item.category;

  if (item.isTop) {
    return (
      <Pressable
        style={({ pressed }) => [styles.leadCard, pressed && styles.cardPressed]}
        onPress={() => onPress(item)}
        accessibilityRole="button"
        accessibilityLabel={`${item.headline}, ${date}`}
      >
        {hasContentImage ? (
          <Image
            source={item.imageUrl}
            style={styles.leadImage}
            contentFit="cover"
            transition={180}
            accessibilityLabel={item.imageAttribution ? `${item.headline}, ${item.imageAttribution}` : item.headline}
          />
        ) : null}
        <View style={styles.leadCopy}>
          <View style={styles.metaRow}>
            <Text style={styles.category}>{category}</Text>
            <Text style={styles.dateText}>{date}</Text>
          </View>
          <Text style={styles.leadHeadline} numberOfLines={3}>{item.headline}</Text>
          <Text style={styles.leadBody} numberOfLines={3}>{item.description}</Text>
          <View style={styles.leadFooter}>
            <Text style={styles.readLabel}>Open update</Text>
            <Text style={styles.readMore}>Read more →</Text>
          </View>
        </View>
      </Pressable>
    );
  }

  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      onPress={() => onPress(item)}
      accessibilityRole="button"
      accessibilityLabel={`${item.headline}, ${date}`}
    >
      <View style={styles.cardCopy}>
        <View style={styles.metaRow}>
          <Text style={styles.category}>{category}</Text>
          <Text style={styles.dateText}>{date}</Text>
        </View>
        <Text style={styles.headlineText} numberOfLines={3}>{item.headline}</Text>
        <Text style={styles.bodyText} numberOfLines={2}>{item.description}</Text>
      </View>
      {hasContentImage ? (
        <Image
          source={item.imageUrl}
          style={styles.thumbnail}
          contentFit="cover"
          transition={180}
          accessibilityLabel={item.imageAttribution ? `${item.headline}, ${item.imageAttribution}` : item.headline}
        />
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  leadCard: {
    borderRadius: 9,
    borderWidth: 1,
    borderColor: FEED_COLORS.border,
    backgroundColor: FEED_COLORS.card,
    overflow: 'hidden',
    borderCurve: 'continuous',
  },
  leadImage: {
    width: '100%',
    height: 190,
    backgroundColor: FEED_COLORS.cardDeep,
  },
  leadCopy: {
    paddingHorizontal: 14,
    paddingTop: 13,
    paddingBottom: 12,
    gap: 9,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  category: {
    flex: 1,
    color: FEED_COLORS.accent,
    fontFamily: 'monospace',
    fontSize: 8,
    lineHeight: 12,
    fontWeight: '800',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  dateText: {
    color: FEED_COLORS.textFaint,
    fontFamily: 'monospace',
    fontSize: 8,
    lineHeight: 12,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  leadHeadline: {
    color: FEED_COLORS.text,
    fontSize: 22,
    lineHeight: 27,
    fontWeight: '900',
    letterSpacing: -0.4,
  },
  leadBody: {
    color: FEED_COLORS.textDim,
    fontSize: 13,
    lineHeight: 19,
  },
  leadFooter: {
    minHeight: 26,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    borderTopColor: FEED_COLORS.border,
    paddingTop: 9,
  },
  readLabel: {
    color: FEED_COLORS.textFaint,
    fontFamily: 'monospace',
    fontSize: 8,
    letterSpacing: 0.7,
    textTransform: 'uppercase',
  },
  readMore: {
    color: FEED_COLORS.accent,
    fontSize: 11,
    lineHeight: 15,
    fontWeight: '900',
  },
  card: {
    minHeight: 132,
    flexDirection: 'row',
    alignItems: 'stretch',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: FEED_COLORS.border,
    backgroundColor: FEED_COLORS.card,
    overflow: 'hidden',
    borderCurve: 'continuous',
  },
  cardCopy: {
    flex: 1,
    minWidth: 0,
    paddingHorizontal: 14,
    paddingVertical: 13,
    gap: 8,
  },
  thumbnail: {
    width: 106,
    minHeight: 132,
    backgroundColor: FEED_COLORS.cardDeep,
  },
  cardPressed: {
    opacity: 0.78,
    transform: [{ scale: 0.995 }],
  },
  headlineText: {
    color: FEED_COLORS.text,
    fontSize: 16,
    lineHeight: 20,
    fontWeight: '900',
    letterSpacing: -0.2,
  },
  bodyText: {
    color: FEED_COLORS.textDim,
    fontSize: 12,
    lineHeight: 17,
  },
});
