import { useCallback, useState } from 'react';
import { Animated, Pressable, RefreshControl, StyleSheet, Text, View, type ScrollViewProps } from 'react-native';
import { useRouter } from 'expo-router';
import { HomeCalendarCard } from '@/features/feed/components/HomeCalendarCard';
import { NarrativeSheet, type NarrativeSheetItem } from '@/features/feed/components/NarrativeSheet';
import { TodayCarousel, TodayCarouselSkeleton } from '@/features/feed/components/StoryCarousel';
import { TopicMosaic } from '@/features/feed/components/TopicMosaic';
import { FeedSectionState } from '@/features/feed/components/feed-section-state';
import { feedItemDetail, fetchFeedItems } from '@/features/feed/feed.api';
import { fetchStories } from '@/features/feed/stories.api';
import { FEED_TOKENS } from '@/features/feed/feed-design';
import { todaySlides } from '@/features/feed/feed-home';
import { sectionFailureTitle } from '@/features/feed/feed-mosaic';
import { FEED_COLORS as color } from '@/features/feed/feed.constants';
import type { FeedItem } from '@/features/feed/feed.types';
import { useFeedSection } from '@/features/feed/use-feed-section';
import { useFocusedAppStateInterval } from '@/hooks/useFocusedAppStateInterval';

const fetchToday = (signal: AbortSignal) => fetchFeedItems(5, 0, { signal });
const fetchSelectedStories = (signal: AbortSignal) => fetchStories({ signal });

// Stories block (docs/design/feed.html .hx-head + .hx-stories .sx-pager):
// a 24px heading row, an 8px gap, then the 264px pager.
const STORIES_HEAD_HEIGHT = 24;
const STORIES_HEAD_GAP = 8;
const STORIES_PAGER_HEIGHT = 264;

export function HomeFeedOverview({ active, onScroll }: {
  active: boolean; onScroll: ScrollViewProps['onScroll']; bottomPadding: number;
}) {
  const router = useRouter();
  const stories = useFeedSection(fetchSelectedStories, active);
  const reports = useFeedSection(fetchToday, active);
  const [refreshing, setRefreshing] = useState(false);
  const [report, setReport] = useState<NarrativeSheetItem | null>(null);
  const [, setClock] = useState(0);
  useFocusedAppStateInterval(() => Promise.all([
    stories.load(true), reports.load(true),
  ]).then(() => undefined), 5 * 60_000, { enabled: active });
  useFocusedAppStateInterval(() => setClock((value) => value + 1), 60_000, { enabled: active });
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try { await Promise.all([stories.load(), reports.load()]); }
    finally { setRefreshing(false); }
  }, [stories.load, reports.load]);
  const openReport = (item: FeedItem) => setReport(feedItemDetail(item));
  const slides = todaySlides(reports.data ?? []);
  const now = new Date();
  const storyList = stories.data ?? [];

  return <>
    <Animated.ScrollView
      style={styles.scroller}
      showsVerticalScrollIndicator={false}
      contentInsetAdjustmentBehavior="automatic"
      scrollEventThrottle={16}
      onScroll={onScroll}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={color.accent} colors={[color.accent]} />}
    >
      <View style={styles.column}>
        <View style={styles.today}>
          {reports.loading && !reports.data ? <TodayCarouselSkeleton /> : null}
          {reports.error && !slides.length ? (
            <FeedSectionState
              title={sectionFailureTitle(reports.error, 'Latest updates unavailable')}
              text="Latest updates could not be loaded."
              onRetry={() => { void reports.load(); }}
            />
          ) : null}
          {slides.length ? (
            <TodayCarousel items={slides} onPress={openReport} onAllUpdates={() => router.push('/feed')} />
          ) : null}
          {reports.data && !slides.length && !reports.error ? <FeedSectionState title="No published updates yet" text="New reports will appear here." /> : null}
          {reports.error && slides.length ? <Text selectable style={styles.latestNotice}>Refresh failed. Showing the last loaded updates.</Text> : null}
        </View>
        <View style={[styles.mosaic, storyList.length ? null : styles.mosaicEmpty]}>
          {stories.loading && !stories.data ? <FeedSectionState title="Loading stories…" loading /> : null}
          {stories.error ? (
            <FeedSectionState
              title={sectionFailureTitle(stories.error, 'Developing stories unavailable')}
              text={storyList.length ? 'Showing the last loaded stories.' : 'Developing stories could not be loaded.'}
              onRetry={() => { void stories.load(); }}
            />
          ) : null}
          {storyList.length ? <TopicMosaic stories={storyList} now={now} /> : null}
          {stories.data && !storyList.length && !stories.error ? <FeedSectionState title="No developing stories" text="New stories will appear here." /> : null}
        </View>
        <View style={styles.calendar}>
          <HomeCalendarCard active={active} />
        </View>
      </View>
    </Animated.ScrollView>
    {stories.pending || reports.pending ? (
      <Pressable accessibilityRole="button" accessibilityLabel="Apply new Feed updates" onPress={() => { stories.apply(); reports.apply(); }} style={styles.newUpdates}>
        <Text style={styles.action}>New updates ↓</Text>
      </Pressable>
    ) : null}
    <NarrativeSheet item={report} onClose={() => setReport(null)} />
  </>;
}

const styles = StyleSheet.create({
  scroller: { flex: 1 },
  content: { flexGrow: 1 },
  column: { flexGrow: 1, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8, gap: 8 },
  today: { gap: 8 },
  mosaic: { height: STORIES_HEAD_HEIGHT + STORIES_HEAD_GAP + STORIES_PAGER_HEIGHT, overflow: 'hidden' },
  mosaicEmpty: { justifyContent: 'center' },
  calendar: { flex: 0, minHeight: 120 },
  latestNotice: { color: FEED_TOKENS.colors.textDim, fontSize: 12, lineHeight: 16 },
  newUpdates: { position: 'absolute', bottom: 12, left: 16, right: 16, zIndex: 2, minHeight: 44, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: color.border, borderRadius: 8, backgroundColor: color.card },
  action: { color: color.accent, fontSize: 12, fontWeight: '700' },
});
