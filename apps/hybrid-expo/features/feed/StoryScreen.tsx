import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TakeActionApps } from './components/TakeActionApps';
import { FeedSectionState } from './components/feed-section-state';
import { FeedBox } from './components/ui/FeedBox';
import { SampleDataLabel } from './components/ui/SampleDataLabel';
import { FEED_TOKENS, monoFontFamily } from './feed-design';
import { storyAge, storyCountLabel, storySample, timelineEvents, timelineLabel } from './feed-stories';
import { useStoryDetail } from './use-story-detail';

/**
 * Story page, "Catch me up" (issue #497, markup per feed-mock.html #s-story,
 * DESIGN.md sections 2, 7). Replaces the StorySheet; real events come from
 * useStoryDetail, the catch-me-up card and key numbers are mock-gated.
 */
export default function StoryScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ slug?: string | string[] }>();
  const slug = Array.isArray(params.slug) ? params.slug[0] : params.slug;
  const { detail, loading, error, loadingMore, loadMoreError, loadEarlierMemories, retry } = useStoryDetail(slug);
  const story = detail?.story ?? null;
  const events = detail ? timelineEvents(detail.events) : [];
  const sample = storySample();
  // One snapshot per render so every label is aged against the same instant.
  const now = new Date();

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
        <Text accessibilityRole="header" style={styles.barLabel}>Story</Text>
        <View style={styles.barSpacer} />
      </View>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={loading}
            onRefresh={retry}
            tintColor={FEED_TOKENS.colors.accent}
            colors={[FEED_TOKENS.colors.accent]}
          />
        }
      >
        {loading && !detail ? <FeedSectionState title="Loading story…" loading /> : null}
        {error && !detail ? (
          <FeedSectionState title="Story unavailable" text="This story could not be loaded." onRetry={retry} />
        ) : null}
        {!story && !loading && !error ? <FeedSectionState title="Story unavailable" text="This story could not be loaded." /> : null}

        {story ? (
          <>
            <View style={styles.metaRow}>
              <Text style={styles.metaName} numberOfLines={1}>
                {story.name} · {storyCountLabel(story.eventCount)}
              </Text>
              <Text style={styles.metaUpdated} numberOfLines={1}>
                Updated {storyAge(story.updatedAt, now)}
              </Text>
            </View>
            <Text accessibilityRole="header" style={styles.title}>{story.name}</Text>

            {sample ? (
              <>
                <FeedBox tone="ground">
                  <SampleDataLabel />
                  <Text style={styles.catchUpLabel}>CATCH ME UP · 30 SEC</Text>
                  <View style={styles.catchUpPoints}>
                    {sample.catchUp.map((point, index) => (
                      <Text key={point} style={[styles.catchUpPoint, index > 0 && styles.catchUpPointDivided]}>{point}</Text>
                    ))}
                  </View>
                </FeedBox>
                <View style={styles.keyNumbers} accessibilityLabel="Sample key numbers">
                  <SampleDataLabel />
                  <View style={styles.keyRow}>
                    {sample.keyNumbers.map((box) => (
                      <FeedBox key={box.label} tone="ground" style={styles.keyBox}>
                        <Text style={styles.keyLabel} numberOfLines={1}>{box.label}</Text>
                        <Text style={styles.keyValue}>{box.value}</Text>
                        <Text style={styles.keyNote} numberOfLines={1}>{box.note}</Text>
                      </FeedBox>
                    ))}
                  </View>
                </View>
              </>
            ) : null}

            <View style={styles.sectionHeader}>
              <Text accessibilityRole="header" style={styles.sectionTitle}>Timeline</Text>
              <Text style={styles.sectionCaption}>NEWEST FIRST</Text>
            </View>
            <View>
              {events.map((event, index) => (
                <View key={`${event.eventAt}-${index}`} style={styles.eventRow}>
                  <View style={styles.markerColumn}>
                    {index < events.length - 1 ? <View style={styles.eventLine} /> : null}
                    <View style={[styles.eventDot, index === 0 && styles.eventDotLatest]} />
                  </View>
                  <View style={styles.eventCopy}>
                    <Text style={styles.eventDate}>{timelineLabel(event.eventAt, now, index === 0)}</Text>
                    <Text style={styles.eventText}>{event.text}</Text>
                  </View>
                </View>
              ))}
            </View>

            {detail && loadMoreError ? (
              <FeedSectionState
                title="Earlier memories unavailable"
                text="Earlier memories on this timeline could not be loaded."
                onRetry={() => void loadEarlierMemories()}
              />
            ) : null}
            {detail?.pagination.hasMore ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Load earlier memories"
                onPress={() => void loadEarlierMemories()}
                disabled={loadingMore}
                style={({ pressed }) => [styles.loadEarlier, pressed && styles.pressed]}
              >
                <Text style={styles.loadEarlierLabel}>{loadingMore ? 'Loading…' : 'Load earlier'}</Text>
              </Pressable>
            ) : null}

            <TakeActionApps storySlug={slug} />
          </>
        ) : null}
      </ScrollView>
    </View>
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
    paddingTop: FEED_TOKENS.space.xs,
    paddingBottom: FEED_TOKENS.space.lg,
    gap: FEED_TOKENS.space.md,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: FEED_TOKENS.space.sm,
  },
  metaName: {
    flexShrink: 1,
    color: FEED_TOKENS.colors.textDim,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    letterSpacing: 1,
  },
  metaUpdated: {
    flexShrink: 1,
    color: FEED_TOKENS.colors.textFaint,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    letterSpacing: 1,
  },
  title: {
    color: FEED_TOKENS.colors.text,
    fontSize: FEED_TOKENS.type.title,
    lineHeight: 34,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  catchUpLabel: {
    color: FEED_TOKENS.colors.accent,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    fontWeight: '600',
    letterSpacing: 1,
  },
  catchUpPoints: {
    gap: 0,
  },
  catchUpPoint: {
    color: FEED_TOKENS.colors.textDim,
    fontSize: FEED_TOKENS.type.body,
    lineHeight: 21,
    paddingVertical: 6,
  },
  catchUpPointDivided: {
    borderTopWidth: 1,
    borderTopColor: FEED_TOKENS.colors.border,
  },
  keyNumbers: {
    alignItems: 'flex-start',
    gap: FEED_TOKENS.space.xs,
  },
  keyRow: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    gap: FEED_TOKENS.space.sm,
  },
  keyBox: {
    flex: 1,
    padding: 10,
    gap: 4,
  },
  keyLabel: {
    color: FEED_TOKENS.colors.textFaint,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    letterSpacing: 1,
  },
  keyValue: {
    color: FEED_TOKENS.colors.text,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.section,
    fontWeight: '700',
  },
  keyNote: {
    color: FEED_TOKENS.colors.textFaint,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.caption,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: FEED_TOKENS.space.md,
    marginTop: FEED_TOKENS.space.sm,
  },
  sectionTitle: {
    flex: 1,
    color: FEED_TOKENS.colors.text,
    fontSize: FEED_TOKENS.type.section,
    fontWeight: '700',
  },
  sectionCaption: {
    color: FEED_TOKENS.colors.textFaint,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    letterSpacing: 1,
  },
  eventRow: {
    flexDirection: 'row',
  },
  markerColumn: {
    width: 18,
    alignItems: 'center',
  },
  eventLine: {
    position: 'absolute',
    top: 8,
    bottom: 0,
    width: 1,
    backgroundColor: FEED_TOKENS.colors.border,
  },
  eventDot: {
    width: 7,
    height: 7,
    marginTop: 6,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: FEED_TOKENS.colors.textFaint,
    backgroundColor: FEED_TOKENS.colors.screen,
  },
  eventDotLatest: {
    backgroundColor: FEED_TOKENS.colors.accent,
    borderColor: FEED_TOKENS.colors.accent,
  },
  eventCopy: {
    flex: 1,
    minWidth: 0,
    paddingLeft: FEED_TOKENS.space.sm,
    paddingBottom: FEED_TOKENS.space.md,
  },
  eventDate: {
    color: FEED_TOKENS.colors.textFaint,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    letterSpacing: 1,
    marginBottom: 4,
  },
  eventText: {
    color: FEED_TOKENS.colors.textDim,
    fontSize: FEED_TOKENS.type.body,
    lineHeight: 21,
  },
  loadEarlier: {
    minHeight: 42,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: FEED_TOKENS.radius.card,
    borderWidth: 1,
    borderColor: FEED_TOKENS.colors.border,
    backgroundColor: FEED_TOKENS.colors.lift,
  },
  loadEarlierLabel: {
    color: FEED_TOKENS.colors.accent,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.caption,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  pressed: {
    opacity: 0.72,
  },
});