import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FeedHeader } from '@/features/feed/components/FeedHeader';
import { FeedList } from '@/features/feed/components/FeedList';
import { FeedSkeleton } from '@/features/feed/components/FeedSkeleton';
import { MarketCalendarModal } from '@/features/feed/components/MarketCalendarModal';
import { NarrativeSheet } from '@/features/feed/components/NarrativeSheet';
import type { NarrativeSheetItem } from '@/features/feed/components/NarrativeSheet';
import { StoryCarousel } from '@/features/feed/components/StoryCarousel';
import { StorySheet } from '@/features/feed/components/StorySheet';
import { fetchFeedItems } from '@/features/feed/feed.api';
import { FEED_COLORS } from '@/features/feed/feed.constants';
import type { FeedItem, StorySummary } from '@/features/feed/feed.types';
import { fetchStories } from '@/features/feed/stories.api';
import { useFocusedAppStateInterval } from '@/hooks/useFocusedAppStateInterval';

const PAGE_SIZE = 20;
const AUTO_REFRESH_MS = 5 * 60 * 1000;
const TIMEAGO_TICK_MS = 60 * 1000;

interface FirstPageOptions {
  showLoading?: boolean;
  surfaceErrors?: boolean;
}

export default function FeedScreen() {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [stories, setStories] = useState<StorySummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [storiesError, setStoriesError] = useState<string | null>(null);
  const [sheetItem, setSheetItem] = useState<NarrativeSheetItem | null>(null);
  const [storySheet, setStorySheet] = useState<StorySummary | null>(null);
  const [calendarVisible, setCalendarVisible] = useState(false);
  const [, setTick] = useState(0);
  const loadingMoreRef = useRef(false);
  const insets = useSafeAreaInsets();

  const loadFirstPage = useCallback(async ({ showLoading = false, surfaceErrors = true }: FirstPageOptions = {}) => {
    if (showLoading) setIsLoading(true);
    if (surfaceErrors) {
      setFeedError(null);
      setStoriesError(null);
    }

    const [storiesResult, feedResult] = await Promise.allSettled([
      fetchStories(),
      fetchFeedItems(PAGE_SIZE, 0),
    ]);

    if (storiesResult.status === 'fulfilled') {
      setStories(storiesResult.value);
      setStoriesError(null);
    } else if (surfaceErrors) {
      setStoriesError(storiesResult.reason instanceof Error ? storiesResult.reason.message : 'Unable to load Stories');
    }

    if (feedResult.status === 'fulfilled') {
      setItems(feedResult.value);
      setHasMore(feedResult.value.length >= PAGE_SIZE);
      setFeedError(null);
    } else if (surfaceErrors) {
      setFeedError(feedResult.reason instanceof Error ? feedResult.reason.message : 'Unable to load Feed');
    }

    if (showLoading) setIsLoading(false);
  }, []);

  useEffect(() => {
    void loadFirstPage({ showLoading: true });
  }, [loadFirstPage]);

  useFocusedAppStateInterval(
    () => void loadFirstPage({ surfaceErrors: false }),
    AUTO_REFRESH_MS,
  );
  useFocusedAppStateInterval(() => setTick((tick) => tick + 1), TIMEAGO_TICK_MS);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await loadFirstPage({ surfaceErrors: false });
    } finally {
      setRefreshing(false);
    }
  }, [loadFirstPage]);

  const handleEndReached = useCallback(async () => {
    if (loadingMoreRef.current || !hasMore || feedError !== null) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);

    try {
      const moreItems = await fetchFeedItems(PAGE_SIZE, items.length);
      if (moreItems.length < PAGE_SIZE) setHasMore(false);
      setItems((current) => [...current, ...moreItems]);
    } catch {
      // The current page remains useful when loading an older page fails.
    } finally {
      setLoadingMore(false);
      loadingMoreRef.current = false;
    }
  }, [feedError, hasMore, items.length]);

  const handleCardPress = useCallback((item: FeedItem) => {
    setSheetItem({
      id: item.id,
      title: item.headline,
      summary: item.description,
      createdAt: item.createdAt,
      imageUrl: item.imageUrl,
      imageKind: item.imageKind,
      imageAttribution: item.imageAttribution,
    });
  }, []);

  const listHeader = (
    <View style={styles.listHeader}>
      <View style={styles.sectionHeading}>
        <Text style={styles.sectionTitle}>Stories</Text>
        <Text style={styles.sectionMeta}>{stories.length} selected</Text>
      </View>

      {stories.length > 0 ? (
        <StoryCarousel stories={stories} onStoryPress={setStorySheet} variant="editorial" />
      ) : null}
      {stories.length === 0 ? (
        <InlineState
          title={storiesError ? 'Stories unavailable' : 'No selected Stories'}
          text={storiesError ?? 'Selected entity timelines will appear here.'}
        />
      ) : null}

      <View style={[styles.sectionHeading, styles.latestHeading]}>
        <Text style={styles.sectionTitle}>Latest</Text>
        <Text style={styles.sectionMeta}>Updated now</Text>
      </View>
    </View>
  );

  const empty = feedError ? (
    <InlineState
      title="Feed unavailable"
      text={feedError}
      actionLabel="Try again"
      onAction={() => void loadFirstPage({ showLoading: true })}
    />
  ) : (
    <InlineState title="No published updates yet" text="Publisher has not emitted new Feed items." />
  );

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <FeedHeader onCalendarPress={() => setCalendarVisible(true)} />

      {isLoading ? <FeedSkeleton /> : (
        <FeedList
          items={items}
          onCardPress={handleCardPress}
          refreshing={refreshing}
          onRefresh={handleRefresh}
          onEndReached={handleEndReached}
          loadingMore={loadingMore}
          header={listHeader}
          empty={empty}
        />
      )}

      <NarrativeSheet item={sheetItem} onClose={() => setSheetItem(null)} />
      <StorySheet story={storySheet} onClose={() => setStorySheet(null)} />
      <MarketCalendarModal visible={calendarVisible} onClose={() => setCalendarVisible(false)} />
    </View>
  );
}

function InlineState({
  title,
  text,
  actionLabel,
  onAction,
}: {
  title: string;
  text: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <View style={styles.stateWrap}>
      <Text style={styles.stateTitle}>{title}</Text>
      <Text style={styles.stateText}>{text}</Text>
      {actionLabel && onAction ? (
        <Pressable onPress={onAction} accessibilityRole="button" style={styles.retryButton}>
          <Text style={styles.retryButtonText}>{actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: FEED_COLORS.screen,
  },
  listHeader: {
    paddingBottom: 12,
  },
  sectionHeading: {
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingBottom: 8,
  },
  latestHeading: {
    paddingTop: 26,
  },
  sectionTitle: {
    color: FEED_COLORS.text,
    fontSize: 24,
    lineHeight: 30,
    fontWeight: '900',
    letterSpacing: -0.35,
  },
  sectionMeta: {
    color: FEED_COLORS.textFaint,
    fontFamily: 'monospace',
    fontSize: 8,
    lineHeight: 12,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  stateWrap: {
    padding: 16,
    borderWidth: 1,
    borderColor: FEED_COLORS.border,
    borderRadius: 8,
    backgroundColor: FEED_COLORS.card,
    gap: 7,
    alignItems: 'flex-start',
    borderCurve: 'continuous',
  },
  stateTitle: {
    color: FEED_COLORS.text,
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '900',
  },
  stateText: {
    color: FEED_COLORS.textDim,
    fontSize: 13,
    lineHeight: 19,
  },
  retryButton: {
    minHeight: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 18,
    backgroundColor: FEED_COLORS.accent,
    paddingHorizontal: 14,
    marginTop: 3,
  },
  retryButtonText: {
    color: FEED_COLORS.cardDeep,
    fontSize: 11,
    lineHeight: 15,
    fontWeight: '900',
  },
});
