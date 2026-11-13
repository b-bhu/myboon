import { useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FeedSectionState } from './components/feed-section-state';
import { FeedBox } from './components/ui/FeedBox';
import { TopicMarketSection } from './components/TopicMarketSection';
import { FEED_TOKENS, monoFontFamily } from './feed-design';
import { topicMarket } from './feed-mosaic';
import { storyAge, storyCountLabel, timelineEvents, timelineLabel } from './feed-stories';
import { useStoryDetail } from './use-story-detail';
import type { StoryEvent } from './feed.types';

/**
 * Topic detail. Real story fields fill the header, latest development and
 * timeline. The market block and pinned action appear only when the story
 * matches a Phoenix market. Causal chain and a separate news list are not
 * returned by the API, so they stay off this screen.
 */
export default function StoryScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ slug?: string | string[] }>();
  const slug = Array.isArray(params.slug) ? params.slug[0] : params.slug;
  const { detail, loading, error, loadingMore, loadMoreError, loadEarlierMemories, retry } = useStoryDetail(slug);
  const story = detail?.story ?? null;
  const events = detail ? timelineEvents(detail.events) : [];
  const now = new Date();
  const link = story ? topicMarket(story.storySlug) : null;
  const latest = events[0];
  const timeline = story
    ? events.filter((event, index) => index !== 0 || event.text !== story.latestDevelopment)
    : [];
  const [openEvents, setOpenEvents] = useState<Record<string, boolean>>({});

  const share = () => {
    if (!story) return;
    void Share.share({ message: `${story.name}\n${story.latestDevelopment}` });
  };

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.bar}>
        <Pressable accessibilityRole="button" accessibilityLabel="Back to Feed" onPress={() => router.back()} style={styles.iconButton}>
          <Text style={styles.backGlyph}>‹</Text>
        </Pressable>
        <Text style={styles.barLabel}>Developing story</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Share topic" onPress={share} style={styles.iconButton}>
          <Text style={styles.shareGlyph}>↑</Text>
        </Pressable>
      </View>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={retry} tintColor={FEED_TOKENS.colors.accent} colors={[FEED_TOKENS.colors.accent]} />}
      >
        {loading && !detail ? <FeedSectionState title="Loading story…" loading /> : null}
        {error && !detail ? (
          <FeedSectionState title="Story unavailable" text="This story could not be loaded. If you are offline, reconnect and try again." onRetry={retry} />
        ) : null}
        {!story && !loading && !error ? <FeedSectionState title="Story unavailable" text="This story could not be loaded." /> : null}
        {story ? (
          <>
            <View style={styles.intro}>
              <View style={styles.kicker}>
                <Text style={styles.kickerText} numberOfLines={1}>{storyCountLabel(story.eventCount)}</Text>
                <Text style={styles.kickerText} numberOfLines={1}>{storyAge(story.updatedAt, now)}</Text>
              </View>
              <Text accessibilityRole="header" style={styles.title}>{story.name}</Text>
              <FeedBox tone="card" style={styles.latest}>
                <View style={styles.kicker}>
                  <Text style={styles.kickerText}>Latest development</Text>
                  {latest ? <Text style={styles.kickerText}>{timelineLabel(latest.eventAt, now, true)}</Text> : null}
                </View>
                <Text style={styles.latestBody} numberOfLines={4}>{story.latestDevelopment}</Text>
              </FeedBox>
            </View>
            {link ? <TopicMarketSection link={link} active /> : null}
            <View style={styles.sectionHead}>
              <Text accessibilityRole="header" style={styles.sectionTitle}>How we got here</Text>
              <Text style={styles.kickerText}>Newest first</Text>
            </View>
            {events.length === 0 ? <FeedSectionState title="No developments yet" text="New developments will appear here." /> : null}
            {timeline.map((event, index) => (
              <TimelineEntry
                key={`${event.eventAt}-${index}`}
                event={event}
                latest={index === 0}
                now={now}
                expanded={openEvents[`${event.eventAt}-${index}`] === true}
                onToggle={() => setOpenEvents((current) => ({ ...current, [`${event.eventAt}-${index}`]: !current[`${event.eventAt}-${index}`] }))}
              />
            ))}
            {detail && loadMoreError ? (
              <FeedSectionState
                title="Earlier developments unavailable"
                text="Earlier developments on this timeline could not be loaded."
                onRetry={() => void loadEarlierMemories()}
              />
            ) : null}
            {detail?.pagination.hasMore ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Load earlier developments"
                onPress={() => void loadEarlierMemories()}
                disabled={loadingMore}
                style={styles.loadEarlier}
              >
                <Text style={styles.loadEarlierLabel}>{loadingMore ? 'Loading…' : 'Load earlier'}</Text>
              </Pressable>
            ) : null}
          </>
        ) : null}
      </ScrollView>
      {link ? (
        <View style={[styles.dock, { paddingBottom: Math.max(insets.bottom, 12) }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${link.action} for ${story?.name ?? 'this topic'}`}
            onPress={() => router.push({ pathname: '/markets/phoenix/[symbol]', params: { symbol: link.symbol } })}
            style={styles.action}
          >
            <Text style={styles.actionLabel}>{link.action}</Text>
          </Pressable>
          <Text style={styles.actionNote}>Optional · continues in MyBoon</Text>
        </View>
      ) : <View style={{ height: insets.bottom }} />}
    </View>
  );
}

function TimelineEntry({
  event,
  latest,
  now,
  expanded,
  onToggle,
}: {
  event: StoryEvent;
  latest: boolean;
  now: Date;
  expanded: boolean;
  onToggle: () => void;
}) {
  const long = event.text.length > 180;
  return (
    <View style={styles.event}>
      <Text style={styles.eventDate}>{timelineLabel(event.eventAt, now, latest)}</Text>
      <Text style={styles.eventText} numberOfLines={expanded || !long ? undefined : 3}>{event.text}</Text>
      {long ? (
        <Pressable accessibilityRole="button" accessibilityLabel={expanded ? 'Show less' : 'Read more'} onPress={onToggle} style={styles.readMoreHit}>
          <Text style={styles.readMore}>{expanded ? 'Show less' : 'Read more'}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: FEED_TOKENS.colors.screen },
  bar: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: FEED_TOKENS.colors.border,
  },
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  backGlyph: { color: FEED_TOKENS.colors.text, fontSize: 28, lineHeight: 32 },
  shareGlyph: { color: FEED_TOKENS.colors.text, fontSize: 18, fontWeight: '700' },
  barLabel: {
    flex: 1,
    textAlign: 'center',
    color: FEED_TOKENS.colors.textDim,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  content: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 24, gap: 12 },
  intro: { gap: 8, marginBottom: 12 },
  kicker: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  kickerText: {
    color: FEED_TOKENS.colors.textFaint,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  title: { color: FEED_TOKENS.colors.text, fontSize: 28, lineHeight: 34, fontWeight: '700', letterSpacing: -0.3 },
  latest: { marginTop: 8, gap: 8, backgroundColor: FEED_TOKENS.colors.card },
  latestBody: { color: FEED_TOKENS.colors.textDim, fontSize: 15, lineHeight: 22 },
  sectionHead: { minHeight: 24, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 12 },
  sectionTitle: { color: FEED_TOKENS.colors.text, fontSize: FEED_TOKENS.type.section, lineHeight: 24, fontWeight: '700' },
  event: { borderWidth: 1, borderColor: FEED_TOKENS.colors.border, borderRadius: 8, backgroundColor: FEED_TOKENS.colors.ground, padding: 12, gap: 6 },
  eventDate: {
    color: FEED_TOKENS.colors.textDim,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  eventText: { color: FEED_TOKENS.colors.text, fontSize: 15, lineHeight: 20 },
  readMoreHit: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' },
  readMore: { color: FEED_TOKENS.colors.accent, fontSize: 15, fontWeight: '600' },
  loadEarlier: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  loadEarlierLabel: { color: FEED_TOKENS.colors.accent, fontSize: 15, fontWeight: '600' },
  dock: { paddingHorizontal: 16, paddingTop: 12, borderTopWidth: 1, borderTopColor: FEED_TOKENS.colors.border, backgroundColor: FEED_TOKENS.colors.screen, gap: 8 },
  action: { minHeight: 48, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: FEED_TOKENS.colors.accent, borderRadius: 6 },
  actionLabel: { color: FEED_TOKENS.colors.accent, fontSize: 15, lineHeight: 20, fontWeight: '600' },
  actionNote: { textAlign: 'center', color: FEED_TOKENS.colors.textFaint, fontFamily: monoFontFamily(), fontSize: 11, letterSpacing: 1, textTransform: 'uppercase' },
});
