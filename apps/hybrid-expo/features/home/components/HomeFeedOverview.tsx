import { useCallback, useState } from 'react';
import { Animated, Pressable, RefreshControl, StyleSheet, Text, useWindowDimensions, View, type ScrollViewProps } from 'react-native';
import { useRouter } from 'expo-router';
import { HomeCalendarCard } from '@/features/feed/components/HomeCalendarCard';
import { NarrativeSheet, type NarrativeSheetItem } from '@/features/feed/components/NarrativeSheet';
import { TodayCarousel } from '@/features/feed/components/StoryCarousel';
import { TopicMosaic } from '@/features/feed/components/TopicMosaic';
import { FeedSectionState } from '@/features/feed/components/feed-section-state';
import { fetchFeedItems } from '@/features/feed/feed.api';
import { fetchStories } from '@/features/feed/stories.api';
import { FEED_TOKENS, monoFontFamily } from '@/features/feed/feed-design';
import { todayLabel, todaySlides } from '@/features/feed/feed-home';
import { feedBandHeights, sectionFailureTitle } from '@/features/feed/feed-mosaic';
import { FEED_COLORS as color } from '@/features/feed/feed.constants';
import type { FeedItem } from '@/features/feed/feed.types';
import { useFeedSection } from '@/features/feed/use-feed-section';
import { useFocusedAppStateInterval } from '@/hooks/useFocusedAppStateInterval';

const fetchToday = (signal: AbortSignal) => fetchFeedItems(5, 0, { signal });
const fetchSelectedStories = (signal: AbortSignal) => fetchStories({ signal });

export function HomeFeedOverview({ active, onScroll }: {
  active: boolean; onScroll: ScrollViewProps['onScroll']; bottomPadding: number;
}) {
  const router = useRouter();
  const { height: windowHeight } = useWindowDimensions();
  const [columnHeight, setColumnHeight] = useState(0);
  const stories = useFeedSection(fetchSelectedStories, active);
  const reports = useFeedSection(fetchToday, active);
  const [refreshing, setRefreshing] = useState(false);
  const [report, setReport] = useState<NarrativeSheetItem | null>(null);
  const [, setClock] = useState(0);
  useFocusedAppStateInterval(() => Promise.all([stories.load(true), reports.load(true)]).then(() => undefined), 5 * 60_000, { enabled: active });
  useFocusedAppStateInterval(() => setClock((value) => value + 1), 60_000, { enabled: active });
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try { await Promise.all([stories.load(), reports.load()]); }
    finally { setRefreshing(false); }
  }, [stories.load, reports.load]);
  const openReport = (item: FeedItem) => setReport({
    id: item.id, title: item.headline, summary: item.description, createdAt: item.createdAt,
    imageUrl: item.imageUrl, imageKind: item.imageKind, imageAttribution: item.imageAttribution,
  });
  const slides = todaySlides(reports.data ?? []);
  const bands = feedBandHeights(windowHeight, columnHeight);
  const now = new Date();
  const storyList = stories.data ?? [];

  return <>
    <Animated.ScrollView
      style={styles.scroller}
      scrollEnabled={false}
      showsVerticalScrollIndicator={false}
      contentInsetAdjustmentBehavior="automatic"
      scrollEventThrottle={16}
      onScroll={onScroll}
      onLayout={(event) => setColumnHeight(event.nativeEvent.layout.height)}
      contentContainerStyle={[styles.content, columnHeight > 0 && { height: columnHeight }]}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={color.accent} colors={[color.accent]} />}
    >
      <View style={[styles.column, columnHeight > 0 && { height: columnHeight }]}>
        <View style={[styles.today, { height: bands.today }]}>
          <View style={styles.todayHeader}>
            <View style={styles.todayHeading}>
              <Text accessibilityRole="header" style={styles.todayTitle}>Today</Text>
              {reports.data ? <Text style={styles.todayMeta}>{todayLabel(now, slides.length)}</Text> : null}
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="All updates" onPress={() => router.push('/feed')} style={styles.todayLink}>
              <Text style={styles.todayLinkLabel}>All updates →</Text>
            </Pressable>
          </View>
          <View style={styles.todayBody}>
            {reports.loading && !reports.data ? <FeedSectionState title="Loading today's updates…" loading /> : null}
            {reports.error ? (
              <FeedSectionState
                title={sectionFailureTitle(reports.error, "Today's updates unavailable")}
                text={reports.data?.length ? 'Showing the last loaded reports.' : "Today's updates could not be loaded."}
                onRetry={() => { void reports.load(); }}
              />
            ) : null}
            {slides.length ? <TodayCarousel items={slides} onPress={openReport} compact /> : null}
            {reports.data && !slides.length && !reports.error ? <FeedSectionState title="No published updates yet" text="New reports will appear here." /> : null}
          </View>
        </View>
        <View style={[styles.mosaic, { height: bands.mosaic }]}>
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
  column: { flexGrow: 1, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8, gap: 8, overflow: 'hidden' },
  today: { gap: 8, overflow: 'hidden' },
  todayHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  todayHeading: { flex: 1, minWidth: 0 },
  todayTitle: { color: FEED_TOKENS.colors.text, fontSize: FEED_TOKENS.type.title, lineHeight: 32, fontWeight: '700', letterSpacing: -0.3 },
  todayMeta: { color: FEED_TOKENS.colors.textDim, fontFamily: monoFontFamily(), fontSize: FEED_TOKENS.type.label, letterSpacing: 1, textTransform: 'uppercase' },
  todayLink: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 4 },
  todayLinkLabel: { color: FEED_TOKENS.colors.accent, fontFamily: monoFontFamily(), fontSize: FEED_TOKENS.type.label, fontWeight: '600', letterSpacing: 0.6, textTransform: 'uppercase' },
  todayBody: { flex: 1, minHeight: 0 },
  mosaic: { overflow: 'hidden' },
  calendar: { flex: 1, minHeight: 96 },
  newUpdates: { position: 'absolute', bottom: 12, left: 16, right: 16, zIndex: 2, minHeight: 44, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: color.border, borderRadius: 8, backgroundColor: color.card },
  action: { color: color.accent, fontSize: 12, fontWeight: '700' },
});
