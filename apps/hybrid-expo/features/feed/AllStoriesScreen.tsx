import { useState } from 'react';
import { Image } from 'expo-image';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useContentImageFailed } from './components/FeedCard';
import { FeedSectionState } from './components/feed-section-state';
import { FeedBox } from './components/ui/FeedBox';
import { SegmentedTabs } from './components/ui/SegmentedTabs';
import { FEED_TOKENS, monoFontFamily } from './feed-design';
import { splitStories, storyHref, storyMeta } from './feed-stories';
import type { StorySummary } from './feed.types';
import { fetchStories } from './stories.api';
import { useFeedSection } from './use-feed-section';
import { useFocusedAppStateInterval } from '@/hooks/useFocusedAppStateInterval';

const ACTIVE_TAB = 'active';
const PAST_TAB = 'past';
const TAB_OPTIONS = [
  { key: ACTIVE_TAB, label: 'ACTIVE' },
  { key: PAST_TAB, label: 'PAST' },
];

// useFeedSection passes a bare signal; fetchStories takes an options bag.
const fetchAllStories = (signal: AbortSignal) => fetchStories({ signal });

/**
 * "All stories" list (issue #497, markup per feed-mock.html #s-allstories,
 * DESIGN.md sections 7, 9). ACTIVE / PAST tabs per the issue spec — the mock's
 * FOLLOWING / ALL tabs are illustrative only; there is no follow feature.
 */
export default function AllStoriesScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [tab, setTab] = useState(ACTIVE_TAB);
  const stories = useFeedSection(fetchAllStories, true);
  useFocusedAppStateInterval(() => { void stories.load(); }, 5 * 60_000);
  // One snapshot per render so every row is aged against the same instant.
  const now = new Date();
  const split = splitStories(stories.data ?? [], now);
  const rows = tab === ACTIVE_TAB ? split.active : split.past;
  const openStory = (slug: string) => router.push(storyHref(slug));

  return (
    <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={styles.bar}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={() => router.back()}
          style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
        >
          <Text style={styles.backGlyph}>‹</Text>
        </Pressable>
        <Text accessibilityRole="header" style={styles.barLabel}>All stories</Text>
        <View style={styles.barSpacer} />
      </View>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={stories.loading}
            onRefresh={() => { void stories.load(); }}
            tintColor={FEED_TOKENS.colors.accent}
            colors={[FEED_TOKENS.colors.accent]}
          />
        }
      >
        <View style={styles.tabs}>
          <SegmentedTabs options={TAB_OPTIONS} value={tab} onChange={setTab} />
        </View>
        {stories.loading && !stories.data ? <FeedSectionState title="Loading stories…" loading /> : null}
        {stories.error ? (
          <FeedSectionState title="Stories unavailable" text="Stories could not be loaded." onRetry={() => { void stories.load(); }} />
        ) : null}
        {stories.data && !rows.length && !stories.loading && !stories.error ? (
          <FeedSectionState title={tab === ACTIVE_TAB ? 'No active stories' : 'No past stories'} />
        ) : null}
        <View style={styles.rows}>
          {rows.map((story) => (
            <StoryRow key={story.storySlug} story={story} now={now} onPress={openStory} />
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

/** Boxed story row (mock #s-allstories .card): 56px thumbnail, title, latest line, mono-cap meta. */
function StoryRow({ story, now, onPress }: { story: StorySummary; now: Date; onPress: (slug: string) => void }) {
  const { hasContentImage, onImageError } = useContentImageFailed(story);
  return (
    <FeedBox
      tone="ground"
      onPress={() => onPress(story.storySlug)}
      accessibilityLabel={`Open story: ${story.name}`}
    >
      <View style={styles.rowTop}>
        {hasContentImage && story.imageUrl ? (
          <Image
            source={story.imageUrl}
            onError={onImageError}
            style={styles.thumbnail}
            contentFit="cover"
            transition={180}
            accessibilityLabel={story.imageAttribution ? `${story.name}, ${story.imageAttribution}` : story.name}
          />
        ) : null}
        <View style={styles.rowCopy}>
          <Text style={styles.rowName} numberOfLines={2}>{story.name}</Text>
          <Text style={styles.rowDevelopment} numberOfLines={2}>{story.latestDevelopment}</Text>
        </View>
      </View>
      <Text style={styles.rowMeta}>{storyMeta(story, now)}</Text>
    </FeedBox>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: FEED_TOKENS.colors.screen,
  },
  bar: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: FEED_TOKENS.space.md,
    gap: FEED_TOKENS.space.sm,
  },
  backButton: {
    width: 44,
    height: 44,
    borderRadius: FEED_TOKENS.radius.button,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: FEED_TOKENS.colors.border,
    backgroundColor: FEED_TOKENS.colors.lift,
  },
  backGlyph: {
    color: FEED_TOKENS.colors.text,
    fontSize: 22,
    lineHeight: 26,
  },
  barLabel: {
    flex: 1,
    color: FEED_TOKENS.colors.text,
    fontSize: FEED_TOKENS.type.secondary,
    fontWeight: '700',
    textAlign: 'center',
  },
  barSpacer: {
    width: 44,
  },
  content: {
    paddingHorizontal: FEED_TOKENS.space.md,
    paddingTop: FEED_TOKENS.space.sm,
    paddingBottom: FEED_TOKENS.space.lg,
    gap: FEED_TOKENS.space.md,
  },
  tabs: {
    minHeight: 44,
    justifyContent: 'center',
  },
  rows: {
    gap: FEED_TOKENS.space.md,
  },
  rowTop: {
    flexDirection: 'row',
    gap: FEED_TOKENS.space.md,
  },
  thumbnail: {
    width: 56,
    height: 56,
    borderRadius: FEED_TOKENS.radius.card,
    backgroundColor: FEED_TOKENS.colors.card,
  },
  rowCopy: {
    flex: 1,
    minHeight: 56,
    minWidth: 0,
    gap: 2,
  },
  rowName: {
    color: FEED_TOKENS.colors.text,
    fontSize: FEED_TOKENS.type.cardTitle,
    lineHeight: 23,
    fontWeight: '600',
  },
  rowDevelopment: {
    color: FEED_TOKENS.colors.textDim,
    fontSize: FEED_TOKENS.type.body,
    lineHeight: 21,
  },
  rowMeta: {
    color: FEED_TOKENS.colors.textFaint,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    lineHeight: 14,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginTop: FEED_TOKENS.space.sm,
  },
  pressed: {
    opacity: 0.72,
  },
});