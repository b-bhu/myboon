import { useEffect, useRef, useState } from 'react';
import { Image } from 'expo-image';
import { Animated, Modal, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { TakeActionApps } from '@/features/feed/components/TakeActionApps';
import { fetchStoryDetail } from '@/features/feed/stories.api';
import { FEED_COLORS } from '@/features/feed/feed.constants';
import { toShortDate } from '@/features/feed/feed.api';
import type { StoryDetail, StorySummary } from '@/features/feed/feed.types';

const STORY_PAGE_SIZE = 20;

interface StorySheetProps {
  story: StorySummary | null;
  onClose: () => void;
}

export function StorySheet({ story, onClose }: StorySheetProps) {
  const { height: screenHeight } = useWindowDimensions();
  const sheetHeight = Math.round(screenHeight * 0.88);
  const translateY = useRef(new Animated.Value(1000)).current;
  const [detail, setDetail] = useState<StoryDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState(false);
  const storySlug = story?.storySlug;

  useEffect(() => {
    Animated.timing(translateY, {
      toValue: story ? 0 : sheetHeight,
      duration: story ? 260 : 220,
      useNativeDriver: true,
    }).start();
  }, [sheetHeight, story, translateY]);

  useEffect(() => {
    let cancelled = false;
    if (!storySlug) {
      setDetail(null);
      setError(false);
      setLoadMoreError(false);
      return;
    }

    setLoading(true);
    setError(false);
    setLoadingMore(false);
    setLoadMoreError(false);
    setDetail(null);
    fetchStoryDetail(storySlug, STORY_PAGE_SIZE, 0)
      .then((nextDetail) => {
        if (!cancelled) setDetail(nextDetail);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [storySlug]);

  async function loadEarlierMemories() {
    if (!storySlug || !detail?.pagination.hasMore || detail.pagination.nextOffset === null || loadingMore) return;
    setLoadingMore(true);
    setLoadMoreError(false);
    try {
      const nextDetail = await fetchStoryDetail(storySlug, STORY_PAGE_SIZE, detail.pagination.nextOffset);
      setDetail((current) => current?.story.storySlug === storySlug ? {
        story: nextDetail.story,
        events: [...current.events, ...nextDetail.events],
        pagination: nextDetail.pagination,
      } : current);
    } catch {
      setLoadMoreError(true);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <Modal
      visible={story !== null}
      transparent
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="Close Story" />
      <Animated.View style={[styles.sheet, { height: sheetHeight + 16, transform: [{ translateY }] }]}>
        <View style={styles.handle} />
        <View style={styles.sheetHeader}>
          <View style={styles.headerCopy}>
            <Text style={styles.eyebrow}>STORY</Text>
            <Text style={styles.updated}>{story ? `Updated ${toShortDate(story.updatedAt)}` : ''}</Text>
          </View>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close Story"
            style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}
          >
            <Text style={styles.closeText}>×</Text>
          </Pressable>
        </View>

        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.content}
        >
          {story?.imageUrl && story.imageKind === 'content' ? (
            <Image
              source={story.imageUrl}
              style={styles.heroImage}
              contentFit="cover"
              transition={180}
              accessibilityLabel={story.imageAttribution ? `${story.name}, ${story.imageAttribution}` : story.name}
            />
          ) : null}
          <Text style={styles.title}>{story?.name ?? ''}</Text>

          {loading ? <Text style={styles.stateText}>Loading Story…</Text> : null}
          {error ? (
            <View style={styles.stateCard}>
              <Text style={styles.stateTitle}>Story unavailable</Text>
              <Text style={styles.stateText}>This timeline could not be loaded.</Text>
            </View>
          ) : null}

          {detail ? (
            <>
              <View style={styles.currentCard}>
                <Text style={styles.currentLabel}>LATEST DEVELOPMENT</Text>
                <Text style={styles.currentText}>{detail.story.latestDevelopment}</Text>
              </View>

              <Text style={styles.timelineLabel}>TIMELINE</Text>
              <Text style={styles.timelineCount}>
                Showing {detail.events.length} of {detail.pagination.total} memories
              </Text>
              <View style={styles.timeline}>
                {detail.events.map((event, index) => (
                  <View key={`${event.eventAt}-${index}`} style={styles.eventRow}>
                    <View style={styles.markerColumn}>
                      {index < detail.events.length - 1 ? <View style={styles.eventLine} /> : null}
                      <View style={[styles.eventDot, index === 0 && styles.eventDotCurrent]} />
                    </View>
                    <View style={styles.eventCopy}>
                      <Text style={styles.eventDate}>{toShortDate(event.eventAt)}</Text>
                      <Text style={styles.eventText}>{event.text}</Text>
                    </View>
                  </View>
                ))}
              </View>
              {loadMoreError ? <Text style={styles.loadMoreError}>Earlier memories could not be loaded.</Text> : null}
              {detail.pagination.hasMore ? (
                <Pressable
                  onPress={() => void loadEarlierMemories()}
                  disabled={loadingMore}
                  accessibilityRole="button"
                  accessibilityLabel="Load earlier Story memories"
                  style={({ pressed }) => [styles.loadMoreButton, pressed && styles.pressed]}
                >
                  <Text style={styles.loadMoreText}>{loadingMore ? 'Loading…' : 'Load earlier'}</Text>
                </Pressable>
              ) : null}
              <TakeActionApps onBeforeNavigate={onClose} />
            </>
          ) : null}
        </ScrollView>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(4, 30, 39, 0.76)',
  },
  sheet: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: -16,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderWidth: 1,
    borderColor: FEED_COLORS.borderSoft,
    backgroundColor: FEED_COLORS.card,
    overflow: 'hidden',
    borderCurve: 'continuous',
  },
  handle: {
    alignSelf: 'center',
    width: 56,
    height: 4,
    marginTop: 12,
    borderRadius: 2,
    backgroundColor: FEED_COLORS.borderSoft,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  headerCopy: {
    flex: 1,
    gap: 4,
  },
  eyebrow: {
    color: FEED_COLORS.accent,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 1.1,
  },
  updated: {
    color: FEED_COLORS.textFaint,
    fontSize: 11,
  },
  closeButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: FEED_COLORS.borderSoft,
    backgroundColor: FEED_COLORS.cardDeep,
  },
  closeText: {
    color: FEED_COLORS.text,
    fontSize: 20,
    lineHeight: 22,
  },
  content: {
    paddingHorizontal: 16,
    paddingTop: 24,
    paddingBottom: 52,
  },
  heroImage: {
    width: '100%',
    height: 210,
    borderRadius: 10,
    marginBottom: 20,
    backgroundColor: FEED_COLORS.cardDeep,
    borderCurve: 'continuous',
  },
  title: {
    color: FEED_COLORS.text,
    fontSize: 28,
    lineHeight: 34,
    fontWeight: '900',
    marginBottom: 24,
  },
  currentCard: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: FEED_COLORS.border,
    backgroundColor: FEED_COLORS.cardActive,
    padding: 14,
    gap: 8,
    marginBottom: 26,
  },
  currentLabel: {
    color: FEED_COLORS.accent,
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 1,
  },
  currentText: {
    color: FEED_COLORS.text,
    fontSize: 15,
    lineHeight: 22,
    fontWeight: '700',
  },
  timelineLabel: {
    color: FEED_COLORS.accent,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 1.1,
    marginBottom: 4,
  },
  timelineCount: {
    color: FEED_COLORS.textFaint,
    fontFamily: 'monospace',
    fontSize: 9,
    lineHeight: 13,
    marginBottom: 16,
  },
  timeline: {
    gap: 0,
  },
  eventRow: {
    flexDirection: 'row',
    minHeight: 90,
  },
  markerColumn: {
    width: 18,
    alignItems: 'center',
  },
  eventLine: {
    position: 'absolute',
    top: 8,
    bottom: -8,
    width: 1,
    backgroundColor: FEED_COLORS.borderSoft,
  },
  eventDot: {
    width: 7,
    height: 7,
    marginTop: 5,
    borderRadius: 4,
    backgroundColor: FEED_COLORS.borderSoft,
  },
  eventDotCurrent: {
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: FEED_COLORS.accent,
  },
  eventCopy: {
    flex: 1,
    paddingLeft: 10,
    paddingBottom: 24,
  },
  eventDate: {
    color: FEED_COLORS.textFaint,
    fontSize: 10,
    marginBottom: 7,
  },
  eventText: {
    color: FEED_COLORS.textDim,
    fontSize: 14,
    lineHeight: 21,
  },
  stateCard: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: FEED_COLORS.border,
    padding: 14,
    gap: 6,
  },
  stateTitle: {
    color: FEED_COLORS.text,
    fontSize: 15,
    fontWeight: '800',
  },
  stateText: {
    color: FEED_COLORS.textDim,
    fontSize: 13,
    lineHeight: 19,
  },
  loadMoreButton: {
    minHeight: 42,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: FEED_COLORS.border,
    backgroundColor: FEED_COLORS.cardDeep,
    borderCurve: 'continuous',
  },
  loadMoreText: {
    color: FEED_COLORS.accent,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '900',
  },
  loadMoreError: {
    color: FEED_COLORS.textDim,
    fontSize: 12,
    lineHeight: 18,
    marginBottom: 12,
  },
  pressed: {
    opacity: 0.72,
  },
});
