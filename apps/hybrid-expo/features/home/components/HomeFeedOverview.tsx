import { useCallback, useState } from 'react';
import { Animated, Pressable, RefreshControl, StyleSheet, Text, View, type ScrollViewProps } from 'react-native';
import { useRouter } from 'expo-router';
import { FeedCard } from '@/features/feed/components/FeedCard';
import { NarrativeSheet, type NarrativeSheetItem } from '@/features/feed/components/NarrativeSheet';
import { StoryCarousel, StoryCarouselSkeleton } from '@/features/feed/components/StoryCarousel';
import { StorySheet } from '@/features/feed/components/StorySheet';
import { FeedSectionState } from '@/features/feed/components/feed-section-state';
import { MarketCalendar } from '@/features/feed/components/market-calendar';
import { TokenStats } from '@/features/feed/components/token-stats';
import { fetchFeedItems } from '@/features/feed/feed.api';
import { fetchStories } from '@/features/feed/stories.api';
import { FEED_COLORS as color } from '@/features/feed/feed.constants';
import type { FeedItem, StorySummary } from '@/features/feed/feed.types';
import { useFeedSection } from '@/features/feed/use-feed-section';
import { useFocusedAppStateInterval } from '@/hooks/useFocusedAppStateInterval';

const fetchPreview = (signal: AbortSignal) => fetchFeedItems(3, 0, { signal });
const fetchSelectedStories = (signal: AbortSignal) => fetchStories({ signal });

export function HomeFeedOverview({ active, onScroll, bottomPadding }: {
  active: boolean; onScroll: ScrollViewProps['onScroll']; bottomPadding: number;
}) {
  const router = useRouter();
  const stories = useFeedSection(fetchSelectedStories, active);
  const reports = useFeedSection(fetchPreview, active);
  const [refreshing, setRefreshing] = useState(false);
  const [story, setStory] = useState<StorySummary | null>(null);
  const [report, setReport] = useState<NarrativeSheetItem | null>(null);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [calendarVersion, setCalendarVersion] = useState(0);
  const [, setClock] = useState(0);
  useFocusedAppStateInterval(() => Promise.all([stories.load(true), reports.load(true)]).then(() => undefined), 5 * 60_000, { enabled: active });
  useFocusedAppStateInterval(() => setClock((value) => value + 1), 60_000, { enabled: active });
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try { await Promise.all([stories.load(), reports.load()]); setCalendarVersion((value) => value + 1); }
    finally { setRefreshing(false); }
  }, [stories.load, reports.load]);
  const openReport = (item: FeedItem) => setReport({ id: item.id, title: item.headline, summary: item.description, createdAt: item.createdAt, imageUrl: item.imageUrl, imageKind: item.imageKind, imageAttribution: item.imageAttribution });
  return <>
    <Animated.ScrollView showsVerticalScrollIndicator={false} contentInsetAdjustmentBehavior="automatic" scrollEventThrottle={16} onScroll={onScroll} contentContainerStyle={[styles.content, { paddingBottom: bottomPadding }]} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={color.accent} colors={[color.accent]} />}>
      <Text accessibilityRole="header" style={styles.pageTitle}>Feed</Text>
      <View style={styles.section}>
        <Text accessibilityRole="header" style={styles.eyebrow}>DEVELOPING STORIES</Text>
        {stories.loading && !stories.data ? <StoryCarouselSkeleton /> : null}
        {stories.error ? <FeedSectionState title="Stories unavailable" text={stories.data?.length ? 'Showing the last loaded Stories.' : 'Developing Stories could not be loaded.'} onRetry={() => { void stories.load(); }} /> : null}
        {stories.data?.length ? <StoryCarousel stories={stories.data} onStoryPress={setStory} selectedSlug={selectedSlug} onSelectStory={setSelectedSlug} /> : null}
        {stories.data && !stories.data.length && !stories.error ? <FeedSectionState title="No developing Stories" text="Developing timelines will appear here." /> : null}
      </View>
      <View style={styles.section}>
        <View style={styles.heading}><Text accessibilityRole="header" style={styles.title}>Latest updates</Text><Pressable accessibilityRole="button" accessibilityLabel="All updates" onPress={() => router.push('/feed')} style={styles.link}><Text style={styles.action}>All updates →</Text></Pressable></View>
        {reports.loading && !reports.data ? <FeedSectionState title="Loading latest updates…" loading /> : null}
        {reports.error ? <FeedSectionState title="Latest updates unavailable" text={reports.data?.length ? 'Showing the last loaded reports.' : 'Reports could not be loaded.'} onRetry={() => { void reports.load(); }} /> : null}
        {reports.data?.map((item) => <FeedCard key={item.id} item={item} onPress={openReport} />)}
        {reports.data && !reports.data.length && !reports.error ? <FeedSectionState title="No published updates yet" text="New reports will appear here." /> : null}
      </View>
      <MarketCalendar active={active} refreshVersion={calendarVersion} />
      <View style={styles.section}>
        <Text accessibilityRole="header" style={styles.title}>Smart wallet activity</Text>
        <FeedSectionState title="Activity unavailable" text="Watched wallet activity isn’t available yet." />
      </View>
      <TokenStats active={active} />
    </Animated.ScrollView>
{stories.pending || reports.pending ? <Pressable accessibilityRole="button" accessibilityLabel="Apply new Feed updates" onPress={() => { stories.apply(); reports.apply(); }} style={styles.newUpdates}><Text style={styles.action}>New updates ↓</Text></Pressable> : null}

    <NarrativeSheet item={report} onClose={() => setReport(null)} />
    <StorySheet story={story} onClose={() => setStory(null)} />
  </>;
}
const styles = StyleSheet.create({
  content: { paddingHorizontal: 16, gap: 26 },
  pageTitle: { color: color.text, fontWeight: '900', fontSize: 56, lineHeight: 70, textAlign: 'center', paddingTop: 22, paddingBottom: 14, letterSpacing: -1.5 },
  section: { gap: 12 }, eyebrow: { color: color.accent, fontSize: 11, lineHeight: 17, fontWeight: '800', letterSpacing: 1.5 },
  heading: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  title: { color: color.text, fontSize: 22, lineHeight: 29, fontWeight: '800' },
  link: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 4 }, action: { color: color.accent, fontSize: 12, fontWeight: '700' },
  newUpdates: { position: 'absolute', bottom: 12, left: 16, right: 16, zIndex: 2, minHeight: 44, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: color.border, borderRadius: 8, backgroundColor: color.card },
});
