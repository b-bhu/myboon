import { useCallback, useState } from 'react';
import { Animated, Pressable, RefreshControl, StyleSheet, Text, View, type ScrollViewProps } from 'react-native';
import { useRouter } from 'expo-router';
import { NarrativeSheet, type NarrativeSheetItem } from '@/features/feed/components/NarrativeSheet';
import { DevelopingStoryCard, StoryCarouselSkeleton, TodayCarousel } from '@/features/feed/components/StoryCarousel';
import { SectionHeader } from '@/features/feed/components/ui/SectionHeader';
import { FeedSectionState } from '@/features/feed/components/feed-section-state';
import { MarketCalendar } from '@/features/feed/components/market-calendar';
import { TokenStats } from '@/features/feed/components/token-stats';
import { SmartWalletActivity } from '@/features/feed/components/smart-wallet-activity';
import { fetchFeedItems } from '@/features/feed/feed.api';
import { fetchStories } from '@/features/feed/stories.api';
import { FEED_TOKENS, monoFontFamily } from '@/features/feed/feed-design';
import { developingStory, todayLabel, todaySlides } from '@/features/feed/feed-home';
import { storyHref } from '@/features/feed/feed-stories';
import { FEED_COLORS as color } from '@/features/feed/feed.constants';
import type { FeedItem } from '@/features/feed/feed.types';
import { useFeedSection } from '@/features/feed/use-feed-section';
import { useFocusedAppStateInterval } from '@/hooks/useFocusedAppStateInterval';

const fetchToday = (signal: AbortSignal) => fetchFeedItems(5, 0, { signal });
const fetchSelectedStories = (signal: AbortSignal) => fetchStories({ signal });

export function HomeFeedOverview({ active, onScroll, bottomPadding }: {
  active: boolean; onScroll: ScrollViewProps['onScroll']; bottomPadding: number;
}) {
  const router = useRouter();
  const stories = useFeedSection(fetchSelectedStories, active);
  const reports = useFeedSection(fetchToday, active);
  const [refreshing, setRefreshing] = useState(false);
  const [report, setReport] = useState<NarrativeSheetItem | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [, setClock] = useState(0);
  useFocusedAppStateInterval(() => Promise.all([stories.load(true), reports.load(true)]).then(() => undefined), 5 * 60_000, { enabled: active });
  useFocusedAppStateInterval(() => setClock((value) => value + 1), 60_000, { enabled: active });
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try { await Promise.all([stories.load(), reports.load()]); setRefreshVersion((value) => value + 1); }
    finally { setRefreshing(false); }
  }, [stories.load, reports.load]);
  const openReport = (item: FeedItem) => setReport({ id: item.id, title: item.headline, summary: item.description, createdAt: item.createdAt, imageUrl: item.imageUrl, imageKind: item.imageKind, imageAttribution: item.imageAttribution });
  const slides = todaySlides(reports.data ?? []);
  const developing = developingStory(stories.data ?? [], new Date());
  return <>
    <Animated.ScrollView showsVerticalScrollIndicator={false} contentInsetAdjustmentBehavior="automatic" scrollEventThrottle={16} onScroll={onScroll} contentContainerStyle={[styles.content, { paddingBottom: bottomPadding }]} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={color.accent} colors={[color.accent]} />}>
      <View style={styles.section}>
        <View style={styles.todayHeader}>
          <View style={styles.todayHeading}>
            <Text accessibilityRole="header" style={styles.todayTitle}>Today</Text>
            {reports.data ? <Text style={styles.todayMeta}>{todayLabel(new Date(), slides.length)}</Text> : null}
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="All updates" onPress={() => router.push('/feed')} style={styles.todayLink}>
            <Text style={styles.todayLinkLabel}>ALL UPDATES →</Text>
          </Pressable>
        </View>
        {reports.loading && !reports.data ? <FeedSectionState title="Loading today's updates…" loading /> : null}
        {reports.error ? <FeedSectionState title="Today's updates unavailable" text={reports.data?.length ? 'Showing the last loaded reports.' : "Today's updates could not be loaded."} onRetry={() => { void reports.load(); }} /> : null}
        {slides.length ? <TodayCarousel items={slides} onPress={openReport} /> : null}
        {reports.data && !slides.length && !reports.error ? <FeedSectionState title="No published updates yet" text="New reports will appear here." /> : null}
      </View>
      <View style={styles.section}>
        <SectionHeader title="Developing story" linkLabel="All stories →" onLinkPress={() => router.push('/stories')} />
        {stories.loading && !stories.data ? <StoryCarouselSkeleton /> : null}
        {stories.error ? <FeedSectionState title="Developing story unavailable" text={stories.data?.length ? 'Showing the last loaded Stories.' : 'Developing story could not be loaded.'} onRetry={() => { void stories.load(); }} /> : null}
        {developing ? <DevelopingStoryCard story={developing} onWatch={(target) => router.push(storyHref(target.storySlug))} /> : null}
        {stories.data && !developing && !stories.error ? <FeedSectionState title="No developing story" text="Active stories from the last 7 days appear here." /> : null}
      </View>
      <MarketCalendar active={active} refreshVersion={refreshVersion} />
      <SmartWalletActivity active={active} refreshVersion={refreshVersion} />
      <TokenStats active={active} refreshVersion={refreshVersion} />
    </Animated.ScrollView>
{stories.pending || reports.pending ? <Pressable accessibilityRole="button" accessibilityLabel="Apply new Feed updates" onPress={() => { stories.apply(); reports.apply(); }} style={styles.newUpdates}><Text style={styles.action}>New updates ↓</Text></Pressable> : null}

    <NarrativeSheet item={report} onClose={() => setReport(null)} />
  </>;
}
const styles = StyleSheet.create({
  content: { paddingHorizontal: 16, gap: 26 },
  section: { gap: 12 },
  todayHeader: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 },
  todayHeading: { gap: 4 },
  todayTitle: { color: FEED_TOKENS.colors.text, fontSize: FEED_TOKENS.type.title, lineHeight: 32, fontWeight: '700', letterSpacing: -0.3 },
  todayMeta: { color: FEED_TOKENS.colors.textDim, fontFamily: monoFontFamily(), fontSize: FEED_TOKENS.type.label, letterSpacing: 1, textTransform: 'uppercase' },
  todayLink: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 4 },
  todayLinkLabel: { color: FEED_TOKENS.colors.accent, fontFamily: monoFontFamily(), fontSize: FEED_TOKENS.type.label, fontWeight: '600', letterSpacing: 1, textTransform: 'uppercase' },
  newUpdates: { position: 'absolute', bottom: 12, left: 16, right: 16, zIndex: 2, minHeight: 44, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: color.border, borderRadius: 8, backgroundColor: color.card },
  action: { color: color.accent, fontSize: 12, fontWeight: '700' },
});