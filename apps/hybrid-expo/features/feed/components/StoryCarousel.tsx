import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { Image } from 'expo-image';
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import type { NativeScrollEvent, NativeSyntheticEvent, ViewStyle } from 'react-native';
import { FEED_COLORS } from '@/features/feed/feed.constants';
import { FEED_TOKENS, monoFontFamily } from '@/features/feed/feed-design';
import { reportSourceName, toRelativeTime, toShortDate } from '@/features/feed/feed.api';
import { carouselIndex, slideTag } from '@/features/feed/feed-home';
import type { FeedItem, StorySummary } from '@/features/feed/feed.types';
import { FeedBox } from './ui/FeedBox';
import { useContentImageFailed } from './FeedCard';
import { selectedStorySlug } from '../feed-state';

const CARD_WIDTH = 288;
const CARD_GAP = 12;

interface StoryCarouselProps {
  stories: StorySummary[];
  onStoryPress: (story: StorySummary) => void;
  variant?: 'compact' | 'editorial';
  selectedSlug?: string | null;
  onSelectStory?: (slug: string) => void;
}

export function StoryCarousel({ stories, onStoryPress, variant = 'compact', selectedSlug = null, onSelectStory }: StoryCarouselProps) {
  const scroll = useRef<ScrollView>(null);
  const { fontScale } = useWindowDimensions();
  const currentSlug = selectedStorySlug(stories, selectedSlug);
  useEffect(() => {
    const index = stories.findIndex((story) => story.storySlug === currentSlug);
    scroll.current?.scrollTo({ x: Math.max(0, index) * (CARD_WIDTH + CARD_GAP), animated: false });
  }, [stories, currentSlug]);
  const rememberSelection = (offset: number) => {
    const story = stories[Math.max(0, Math.min(stories.length - 1, Math.round(offset / (CARD_WIDTH + CARD_GAP))))];
    if (story) onSelectStory?.(story.storySlug);
  };
  return (
    <ScrollView
      ref={scroll}
      horizontal
      showsHorizontalScrollIndicator={false}
      decelerationRate="fast"
      snapToInterval={CARD_WIDTH + CARD_GAP}
      contentContainerStyle={styles.content}
      onMomentumScrollEnd={(event) => rememberSelection(event.nativeEvent.contentOffset.x)}
      onScrollEndDrag={(event) => { if (!event.nativeEvent.velocity?.x) rememberSelection(event.nativeEvent.contentOffset.x); }}
    >
      {stories.map((story) => (
        variant === 'editorial'
          ? <EditorialStoryCard key={story.storySlug} story={story} onPress={onStoryPress} />
          : <CompactStoryCard key={story.storySlug} story={story} onPress={(value) => { onSelectStory?.(value.storySlug); onStoryPress(value); }} largeText={fontScale > 1.15} />
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

function CompactStoryCard({ story, onPress, largeText }: { story: StorySummary; onPress: (story: StorySummary) => void; largeText: boolean }) {
  const markerCount = Math.min(3, Math.max(1, story.eventCount));
  return (
    <StoryPressable story={story} onPress={onPress} style={styles.compactCard}>
      <View style={styles.titleRow}>
        <Text style={styles.compactTitle} numberOfLines={largeText ? 2 : 1}>{story.name}</Text>
        <Text style={styles.date}>{toShortDate(story.updatedAt)}</Text>
      </View>
      <View style={styles.compactDevelopmentRow}>
        <TimelineMini markerCount={markerCount} currentIndex={markerCount - 1} />
        <Text style={styles.compactDevelopment} numberOfLines={3}>{story.latestDevelopment}</Text>
      </View>
      <Text style={styles.compactArrow}>Full story →</Text>
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

interface TodayCarouselProps {
  items: FeedItem[];
  onPress: (item: FeedItem) => void;
}

/**
 * "Today" paged carousel (feed-mock.html .slide/.bars): one full-width boxed
 * card per view, gold progress bars below. No auto-advance — safe for
 * reduced motion; the active bar follows manual swipes only.
 */
export function TodayCarousel({ items, onPress }: TodayCarouselProps) {
  const [slideWidth, setSlideWidth] = useState(0);
  const [active, setActive] = useState(0);
  if (!items.length) return null;
  const current = Math.min(active, items.length - 1);
  const track = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (slideWidth > 0) setActive(carouselIndex(event.nativeEvent.contentOffset.x, slideWidth, items.length));
  };
  return (
    <View
      onLayout={(event) => {
        const width = event.nativeEvent.layout.width;
        if (width > 0) setSlideWidth(width);
      }}
    >
      {slideWidth > 0 ? (
        <>
          <ScrollView
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            scrollEventThrottle={16}
            onScroll={track}
            onMomentumScrollEnd={track}
          >
            {items.map((item) => (
              <View key={item.id} style={{ width: slideWidth }}>
                <TodaySlide item={item} onPress={onPress} />
              </View>
            ))}
          </ScrollView>
          <View style={styles.todayBars} accessibilityLabel={`Update ${current + 1} of ${items.length}`}>
            {items.map((item, index) => (
              <View key={item.id} style={[styles.todayBar, index === current && styles.todayBarActive]} />
            ))}
          </View>
        </>
      ) : null}
    </View>
  );
}

function TodaySlide({ item, onPress }: { item: FeedItem; onPress: (item: FeedItem) => void }) {
  const { hasContentImage, onImageError } = useContentImageFailed(item);
  const tag = slideTag(item);
  const time = toRelativeTime(item.createdAt);
  const source = reportSourceName(item.sourceName);
  const tagChip = tag ? (
    <View
      style={[styles.todaySlideTagChrome, hasContentImage ? styles.todaySlideTag : styles.todaySlideTagInline]}
      accessibilityElementsHidden
    >
      <Text style={styles.todaySlideTagText}>{tag}</Text>
    </View>
  ) : null;
  return (
    <FeedBox
      tone="ground"
      onPress={() => onPress(item)}
      accessibilityLabel={`${item.headline}, ${tag}, ${time}`}
      style={styles.todaySlide}
    >
      {hasContentImage && item.imageUrl ? (
        <View style={styles.todaySlideImageWrap}>
          <Image
            source={item.imageUrl}
            onError={onImageError}
            style={styles.todaySlideImage}
            contentFit="cover"
            transition={180}
            accessibilityLabel={item.imageAttribution ? `${item.headline}, ${item.imageAttribution}` : item.headline}
          />
          {tagChip}
        </View>
      ) : null}
      <View style={styles.todaySlideCopy}>
        {!hasContentImage && tagChip}
        <View style={styles.todaySlideMeta}>
          <Text style={styles.monoLabel} numberOfLines={1}>{time}</Text>
          {source ? <Text style={[styles.monoLabel, styles.todaySlideMetaSource]} numberOfLines={1}>{source}</Text> : null}
        </View>
        <Text style={styles.todaySlideHeadline} numberOfLines={3}>{item.headline}</Text>
        <Text style={styles.todaySlideBody} numberOfLines={2}>{item.description}</Text>
      </View>
    </FeedBox>
  );
}

interface DevelopingStoryCardProps {
  story: StorySummary;
  onWatch: (story: StorySummary) => void;
}

/** "Developing story" card (feed-mock.html .card.story): whole card opens the story. */
export function DevelopingStoryCard({ story, onWatch }: DevelopingStoryCardProps) {
  const { hasContentImage, onImageError } = useContentImageFailed(story);
  const filled = Math.min(3, Math.max(0, story.eventCount));
  return (
    <FeedBox
      tone="ground"
      onPress={() => onWatch(story)}
      accessibilityLabel={`Watch full story: ${story.name}, updated ${toRelativeTime(story.updatedAt)}`}
    >
      <View style={styles.developingTop}>
        {hasContentImage && story.imageUrl ? (
          <Image
            source={story.imageUrl}
            onError={onImageError}
            style={styles.developingImage}
            contentFit="cover"
            transition={180}
            accessibilityLabel={story.imageAttribution ? `${story.name}, ${story.imageAttribution}` : story.name}
          />
        ) : null}
        <View style={styles.developingHeader}>
          <Text style={styles.monoLabel}>{story.eventCount} updates</Text>
          <Text style={styles.developingTitle} numberOfLines={2}>{story.name}</Text>
          <View style={styles.developingTimeline} accessibilityElementsHidden>
            {Array.from({ length: 3 }, (_, index) => (
              <Fragment key={index}>
                {index > 0 ? <View style={styles.developingTimelineLink} /> : null}
                <View style={[styles.developingTimelineSquare, index < filled && styles.developingTimelineSquareOn]} />
              </Fragment>
            ))}
          </View>
        </View>
      </View>
      <Text style={styles.developingBody} numberOfLines={2}>{story.latestDevelopment}</Text>
      <View style={styles.developingFooter}>
        <Text style={styles.monoLabel}>Updated {toRelativeTime(story.updatedAt)}</Text>
        <Text style={styles.developingWatch} accessibilityElementsHidden>WATCH FULL STORY</Text>
      </View>
    </FeedBox>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: CARD_GAP,
    paddingRight: 56,
  },
  compactCard: {
    width: CARD_WIDTH,
    minHeight: 145,
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
    alignSelf: 'flex-end',
    marginTop: 8,
    color: FEED_COLORS.accent,
    fontSize: 11,
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
  // Shared small mono label (DESIGN.md §2: mono, uppercase, 1px letterspacing).
  monoLabel: {
    color: FEED_TOKENS.colors.textDim,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  // Today slide (mock .slide): boxed card, image bleed, 12 padding copy block.
  todaySlide: {
    width: '100%',
    padding: 0,
    overflow: 'hidden',
  },
  todaySlideImageWrap: {
    height: 178,
    backgroundColor: FEED_TOKENS.colors.card,
  },
  todaySlideImage: {
    width: '100%',
    height: 178,
    backgroundColor: FEED_TOKENS.colors.card,
  },
  // Tag chip (mock .slide .tag): chrome carries the visuals; over the image
  // the chip is absolute (left/top 12), inline it stays in normal flow.
  todaySlideTag: {
    position: 'absolute',
    left: FEED_TOKENS.space.md,
    top: FEED_TOKENS.space.md,
  },
  todaySlideTagChrome: {
    alignSelf: 'flex-start',
    backgroundColor: FEED_TOKENS.colors.screen,
    borderWidth: 1,
    borderColor: FEED_TOKENS.colors.border,
    borderRadius: FEED_TOKENS.radius.chip,
    paddingVertical: FEED_TOKENS.space.xs,
    paddingHorizontal: FEED_TOKENS.space.sm,
  },
  todaySlideTagInline: {
    position: 'relative',
    marginBottom: FEED_TOKENS.space.sm,
  },
  todaySlideTagText: {
    color: FEED_TOKENS.colors.textDim,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  todaySlideCopy: {
    padding: FEED_TOKENS.space.md,
    gap: FEED_TOKENS.space.sm,
    flexShrink: 1,
    minWidth: 0,
  },
  todaySlideMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: FEED_TOKENS.space.sm,
  },
  todaySlideMetaSource: {
    flexShrink: 1,
    textAlign: 'right',
  },
  todaySlideHeadline: {
    color: FEED_TOKENS.colors.text,
    fontSize: FEED_TOKENS.type.section,
    lineHeight: 25,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  todaySlideBody: {
    color: FEED_TOKENS.colors.textDim,
    fontSize: FEED_TOKENS.type.body,
    lineHeight: 21,
  },
  // Progress bars (mock .bars): one flex bar per slide, active one gold.
  todayBars: {
    flexDirection: 'row',
    gap: FEED_TOKENS.space.xs,
    marginTop: FEED_TOKENS.space.sm,
  },
  todayBar: {
    flex: 1,
    height: 3,
    borderRadius: 0,
    backgroundColor: FEED_TOKENS.colors.textFaint,
    opacity: 0.5,
  },
  todayBarActive: {
    backgroundColor: FEED_TOKENS.colors.accent,
    opacity: 1,
  },
  // Developing story card (mock .card.story): 84 image left, hairline footer.
  developingImage: {
    width: 84,
    height: 84,
    borderRadius: FEED_TOKENS.radius.button,
    backgroundColor: FEED_TOKENS.colors.card,
  },
  developingTop: {
    flexDirection: 'row',
    gap: FEED_TOKENS.space.md,
  },
  developingHeader: {
    flex: 1,
    minWidth: 0,
  },
  developingTitle: {
    marginTop: FEED_TOKENS.space.xs,
    color: FEED_TOKENS.colors.text,
    fontSize: FEED_TOKENS.type.cardTitle,
    lineHeight: 23,
    fontWeight: '700',
  },
  developingTimeline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: FEED_TOKENS.space.xs,
    marginTop: FEED_TOKENS.space.xs,
    marginBottom: FEED_TOKENS.space.sm,
  },
  developingTimelineSquare: {
    width: 6,
    height: 6,
    borderWidth: 1,
    borderColor: FEED_TOKENS.colors.textFaint,
  },
  developingTimelineSquareOn: {
    backgroundColor: FEED_TOKENS.colors.text,
    borderColor: FEED_TOKENS.colors.text,
  },
  developingTimelineLink: {
    width: 14,
    height: 1,
    backgroundColor: FEED_TOKENS.colors.border,
  },
  developingBody: {
    color: FEED_TOKENS.colors.textDim,
    fontSize: FEED_TOKENS.type.body,
    lineHeight: 21,
  },
  developingFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: FEED_TOKENS.space.sm,
    borderTopWidth: 1,
    borderTopColor: FEED_TOKENS.colors.border,
    marginTop: FEED_TOKENS.space.sm,
    paddingTop: FEED_TOKENS.space.sm,
  },
  developingWatch: {
    color: FEED_TOKENS.colors.accent,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
});
