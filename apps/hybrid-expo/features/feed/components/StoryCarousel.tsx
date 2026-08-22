import type { ReactNode } from 'react';
import { Image } from 'expo-image';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { ViewStyle } from 'react-native';
import { FEED_COLORS } from '@/features/feed/feed.constants';
import { toShortDate } from '@/features/feed/feed.api';
import type { StorySummary } from '@/features/feed/feed.types';

const CARD_WIDTH = 288;
const CARD_GAP = 12;

interface StoryCarouselProps {
  stories: StorySummary[];
  onStoryPress: (story: StorySummary) => void;
  variant?: 'compact' | 'editorial';
}

export function StoryCarousel({ stories, onStoryPress, variant = 'compact' }: StoryCarouselProps) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      decelerationRate="fast"
      snapToInterval={CARD_WIDTH + CARD_GAP}
      contentContainerStyle={styles.content}
    >
      {stories.map((story) => (
        variant === 'editorial'
          ? <EditorialStoryCard key={story.storySlug} story={story} onPress={onStoryPress} />
          : <CompactStoryCard key={story.storySlug} story={story} onPress={onStoryPress} />
      ))}
    </ScrollView>
  );
}

function StoryPressable({
  story,
  onPress,
  children,
  style,
}: {
  story: StorySummary;
  onPress: (story: StorySummary) => void;
  children: ReactNode;
  style: ViewStyle;
}) {
  return (
    <Pressable
      onPress={() => onPress(story)}
      accessibilityRole="button"
      accessibilityLabel={`Open ${story.name} Story, updated ${toShortDate(story.updatedAt)}`}
      style={({ pressed }) => [style, pressed && styles.cardPressed]}
    >
      {children}
    </Pressable>
  );
}

function CompactStoryCard({ story, onPress }: { story: StorySummary; onPress: (story: StorySummary) => void }) {
  const markerCount = Math.min(3, Math.max(1, story.eventCount));
  return (
    <StoryPressable story={story} onPress={onPress} style={styles.compactCard}>
      <View style={styles.titleRow}>
        <Text style={styles.compactTitle} numberOfLines={1}>{story.name}</Text>
        <Text style={styles.date}>{toShortDate(story.updatedAt)}</Text>
      </View>
      <View style={styles.compactDevelopmentRow}>
        <TimelineMini markerCount={markerCount} currentIndex={markerCount - 1} />
        <Text style={styles.compactDevelopment} numberOfLines={3}>{story.latestDevelopment}</Text>
      </View>
      <Text style={styles.compactArrow} accessibilityElementsHidden>→</Text>
    </StoryPressable>
  );
}

function EditorialStoryCard({ story, onPress }: { story: StorySummary; onPress: (story: StorySummary) => void }) {
  const markerCount = Math.min(3, Math.max(1, story.eventCount));
  const hasContentImage = story.imageKind === 'content' && Boolean(story.imageUrl);
  return (
    <StoryPressable story={story} onPress={onPress} style={styles.editorialCard}>
      {hasContentImage ? (
        <Image
          source={story.imageUrl}
          style={styles.image}
          contentFit="cover"
          transition={180}
          accessibilityLabel={story.imageAttribution ? `${story.name}, ${story.imageAttribution}` : story.name}
        />
      ) : null}
      <View style={[styles.editorialCopy, !hasContentImage && styles.editorialCopyWithoutImage]}>
        <View style={styles.titleRow}>
          <Text style={[styles.editorialTitle, !hasContentImage && styles.editorialTitleWithoutImage]} numberOfLines={1}>{story.name}</Text>
          <Text style={styles.date}>{toShortDate(story.updatedAt)}</Text>
        </View>
        <View style={styles.editorialDevelopmentRow}>
          <TimelineMini markerCount={markerCount} currentIndex={0} />
          <Text style={styles.editorialDevelopment} numberOfLines={3}>{story.latestDevelopment}</Text>
        </View>
        <View style={styles.editorialFooter}>
          <Text style={styles.eventCount}>{story.eventCount} memories</Text>
          <Text style={styles.editorialArrow} accessibilityElementsHidden>→</Text>
        </View>
      </View>
    </StoryPressable>
  );
}

function TimelineMini({ markerCount, currentIndex }: { markerCount: number; currentIndex: number }) {
  return (
    <View style={styles.timeline} accessibilityElementsHidden>
      <View style={styles.timelineLine} />
      {Array.from({ length: markerCount }, (_, index) => (
        <View key={index} style={[styles.timelineDot, index === currentIndex && styles.timelineDotCurrent]} />
      ))}
    </View>
  );
}

export function StoryCarouselSkeleton() {
  return (
    <View style={styles.skeletonRow}>
      <View style={[styles.compactCard, styles.skeletonCard]}>
        <View style={[styles.skeletonLine, styles.skeletonTitle]} />
        <View style={[styles.skeletonLine, styles.skeletonBody]} />
        <View style={[styles.skeletonLine, styles.skeletonBodyShort]} />
      </View>
      <View style={[styles.compactCard, styles.skeletonPeek]} />
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: CARD_GAP,
    paddingRight: 56,
  },
  compactCard: {
    width: CARD_WIDTH,
    height: 145,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: FEED_COLORS.border,
    backgroundColor: FEED_COLORS.cardDeep,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 12,
    overflow: 'hidden',
  },
  editorialCard: {
    width: CARD_WIDTH,
    height: 218,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: FEED_COLORS.border,
    backgroundColor: FEED_COLORS.card,
    overflow: 'hidden',
    borderCurve: 'continuous',
  },
  cardPressed: {
    opacity: 0.76,
    transform: [{ scale: 0.995 }],
  },
  image: {
    width: '100%',
    height: 96,
    backgroundColor: FEED_COLORS.cardDeep,
  },
  editorialCopy: {
    flex: 1,
    paddingHorizontal: 14,
    paddingTop: 11,
    paddingBottom: 9,
  },
  editorialCopyWithoutImage: {
    justifyContent: 'center',
    paddingTop: 18,
    paddingBottom: 14,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  compactTitle: {
    flex: 1,
    color: FEED_COLORS.text,
    fontSize: 21,
    lineHeight: 28,
    fontWeight: '900',
  },
  editorialTitle: {
    flex: 1,
    color: FEED_COLORS.text,
    fontSize: 18,
    lineHeight: 23,
    fontWeight: '900',
  },
  editorialTitleWithoutImage: {
    fontSize: 22,
    lineHeight: 28,
  },
  date: {
    color: FEED_COLORS.textFaint,
    fontSize: 10,
    lineHeight: 14,
    marginTop: 3,
  },
  compactDevelopmentRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    marginTop: 11,
    paddingRight: 6,
    minHeight: 54,
    gap: 10,
  },
  editorialDevelopmentRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    marginTop: 8,
    paddingRight: 6,
    minHeight: 44,
    gap: 10,
  },
  timeline: {
    width: 10,
    minHeight: 42,
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 3,
  },
  timelineLine: {
    position: 'absolute',
    top: 7,
    bottom: 7,
    width: 1,
    backgroundColor: FEED_COLORS.borderSoft,
  },
  timelineDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: FEED_COLORS.borderSoft,
  },
  timelineDotCurrent: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: FEED_COLORS.accent,
  },
  compactDevelopment: {
    flex: 1,
    color: FEED_COLORS.textDim,
    fontSize: 13,
    lineHeight: 18,
  },
  editorialDevelopment: {
    flex: 1,
    color: FEED_COLORS.textDim,
    fontSize: 12,
    lineHeight: 17,
  },
  compactArrow: {
    position: 'absolute',
    right: 16,
    bottom: 9,
    color: FEED_COLORS.accent,
    fontSize: 18,
    lineHeight: 22,
    fontWeight: '900',
  },
  editorialFooter: {
    minHeight: 19,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingLeft: 20,
  },
  eventCount: {
    color: FEED_COLORS.textFaint,
    fontFamily: 'monospace',
    fontSize: 8,
    lineHeight: 12,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  editorialArrow: {
    color: FEED_COLORS.accent,
    fontSize: 18,
    lineHeight: 22,
    fontWeight: '900',
  },
  skeletonRow: {
    height: 145,
    flexDirection: 'row',
    gap: CARD_GAP,
    overflow: 'hidden',
  },
  skeletonCard: {
    gap: 14,
    opacity: 0.72,
  },
  skeletonPeek: {
    width: 72,
    opacity: 0.46,
  },
  skeletonLine: {
    height: 12,
    borderRadius: 4,
    backgroundColor: FEED_COLORS.borderSoft,
  },
  skeletonTitle: {
    width: '48%',
    height: 20,
  },
  skeletonBody: {
    width: '92%',
  },
  skeletonBodyShort: {
    width: '64%',
  },
});
