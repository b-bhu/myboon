import { useEffect, useMemo, useRef, useState } from 'react';
import { Image } from 'expo-image';
import { Animated, Modal, PanResponder, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { TakeActionApps } from '@/features/feed/components/TakeActionApps';
import { fetchNarrativeDetail } from '@/features/feed/feed.api';
import type { NarrativeDetail } from '@/features/feed/feed.api';
import { FEED_TOKENS, monoFontFamily } from '@/features/feed/feed-design';
import { newsSheetHeight, shouldDismissSheet, updateAge } from '@/features/feed/feed-updates';
import { useReducedMotion } from '../use-reduced-motion';

function normalizeArticleText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\\n/g, '\n').trim();
}

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

function ArticleBody({ content }: { content: string }) {
  const blocks = normalizeArticleText(content).split(/\n\s*\n+/).filter(Boolean);

  return (
    <View style={styles.articleBody}>
      {blocks.map((block, blockIndex) => {
        const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
        const firstLine = lines[0] ?? '';
        const heading = firstLine.match(/^#{1,3}\s+(.+)$/);
        const bullets = lines
          .map((line) => line.match(/^(?:[-*•]|\d+[.)])\s+(.+)$/)?.[1])
          .filter((line): line is string => Boolean(line));

        if (heading && lines.length === 1) {
          return <Text key={blockIndex} style={styles.articleHeading}>{stripInlineMarkdown(heading[1])}</Text>;
        }

        if (bullets.length === lines.length) {
          return (
            <View key={blockIndex} style={styles.bulletList}>
              {bullets.map((line, lineIndex) => (
                <View key={lineIndex} style={styles.bulletRow}>
                  <Text style={styles.bulletMarker}>•</Text>
                  <Text style={[styles.articleText, styles.bulletText]}>{stripInlineMarkdown(line)}</Text>
                </View>
              ))}
            </View>
          );
        }

        return <Text key={blockIndex} style={styles.articleText}>{stripInlineMarkdown(lines.join('\n'))}</Text>;
      })}
    </View>
  );
}

export interface NarrativeSheetItem {
  id: string;
  title: string;
  summary: string;
  createdAt: string;
  imageUrl?: string | null;
  imageKind?: 'content' | 'source_avatar' | null;
  imageAttribution?: string | null;
}

interface NarrativeSheetProps {
  item: NarrativeSheetItem | null;
  onClose: () => void;
}

export function NarrativeSheet({ item, onClose }: NarrativeSheetProps) {
  const reducedMotion = useReducedMotion();
  const [retry, setRetry] = useState(0);
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const { height: screenHeight } = useWindowDimensions();
  const sheetHeight = newsSheetHeight(screenHeight);
  const translateY = useRef(new Animated.Value(1000)).current;
  const dragY = useRef(new Animated.Value(0)).current;
  const [detail, setDetail] = useState<NarrativeDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const itemId = item?.id;

  // Always-current close callback for the pan-release handler.
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    dragY.setValue(0);
    Animated.timing(translateY, {
      toValue: item ? 0 : sheetHeight,
      duration: reducedMotion ? 0 : item ? 260 : 220,
      useNativeDriver: true,
    }).start();
  }, [item, sheetHeight, translateY, dragY, reducedMotion]);

  const panResponder = useMemo(() => {
    const settle = () => {
      if (reducedMotion) {
        Animated.timing(dragY, { toValue: 0, duration: 0, useNativeDriver: true }).start();
      } else {
        Animated.spring(dragY, { toValue: 0, bounciness: 0, useNativeDriver: true }).start();
      }
    };
    return PanResponder.create({
      onMoveShouldSetPanResponder: (_event, gesture) => gesture.dy > 4 && gesture.dy > Math.abs(gesture.dx),
      onPanResponderMove: (_event, gesture) => {
        dragY.setValue(Math.max(0, gesture.dy));
      },
      onPanResponderRelease: (_event, gesture) => {
        if (shouldDismissSheet(Math.max(0, gesture.dy), gesture.vy, sheetHeight)) {
          onCloseRef.current();
          return;
        }
        settle();
      },
      onPanResponderTerminate: settle,
    });
  }, [dragY, sheetHeight, reducedMotion]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    if (!itemId) {
      setDetail(null);
      setError(false);
      return;
    }

    setLoading(true);
    setError(false);
    setDetail(null);
    fetchNarrativeDetail(itemId, { signal: controller.signal })
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
      controller.abort();
    };
  }, [itemId, retry]);

  const title = detail?.title ?? item?.title ?? '';
  const summary = detail?.summary ?? item?.summary ?? '';
  const publishedAt = detail?.publishedAt ?? item?.createdAt ?? '';
  const imageUrl = detail?.imageUrl ?? item?.imageUrl ?? null;
  const imageKind = detail?.imageKind ?? item?.imageKind ?? null;
  const age = updateAge(publishedAt, new Date());
  const meta = age ? `${age} · LATEST` : 'LATEST';

  return (
    <Modal
      visible={item !== null}
      transparent
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="Close news" />
      <Animated.View
        style={[styles.sheet, { height: sheetHeight, transform: [{ translateY: Animated.add(translateY, dragY) }] }]}
      >
        <View style={styles.grabberArea} {...panResponder.panHandlers}>
          <View style={styles.grabber} />
        </View>

        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
          <Text style={styles.meta}>{meta}</Text>
          <Text style={styles.title}>{title}</Text>
          {imageUrl && imageKind === 'content' && failedImage !== imageUrl ? (
            <Image
              source={imageUrl}
              onError={() => setFailedImage(imageUrl)}
              style={styles.heroImage}
              contentFit="cover"
              transition={reducedMotion ? 0 : 180}
              accessibilityLabel={detail?.imageAttribution ?? item?.imageAttribution ?? title}
            />
          ) : null}
          <Text style={styles.lead}>{summary}</Text>

          {loading ? <Text style={styles.loadingText}>Loading the full Feed item…</Text> : null}
          {error ? (
            <View style={styles.stateCard}>
              <Text style={styles.stateTitle}>Full Feed item unavailable</Text>
              <Text style={styles.stateText}>The shorter update is still available above.</Text>
              <Pressable accessibilityRole="button" onPress={() => setRetry((value) => value + 1)} style={{ minHeight: 44, justifyContent: 'center' }}><Text style={{ color: FEED_TOKENS.colors.accent }}>Try again</Text></Pressable>
            </View>
          ) : null}
          {detail?.content ? (
            <>
              <Text style={styles.sectionLabel}>THE FULL PICTURE</Text>
              <ArticleBody content={detail.content} />
            </>
          ) : null}

          <TakeActionApps onBeforeNavigate={onClose} />
        </ScrollView>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(2, 24, 33, 0.8)',
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: FEED_TOKENS.radius.sheet,
    borderTopRightRadius: FEED_TOKENS.radius.sheet,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: FEED_TOKENS.colors.border,
    backgroundColor: FEED_TOKENS.colors.ground,
    overflow: 'hidden',
    borderCurve: 'continuous',
  },
  grabberArea: {
    height: 24,
    alignItems: 'center',
  },
  grabber: {
    width: 36,
    height: 4,
    marginTop: 8,
    borderRadius: 2,
    backgroundColor: FEED_TOKENS.colors.border,
  },
  content: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 32,
  },
  meta: {
    color: FEED_TOKENS.colors.textFaint,
    fontFamily: monoFontFamily(),
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  title: {
    color: FEED_TOKENS.colors.text,
    fontSize: 20,
    lineHeight: 25,
    fontWeight: '700',
    marginTop: 12,
  },
  heroImage: {
    width: '100%',
    height: 210,
    borderRadius: FEED_TOKENS.radius.card,
    marginTop: 12,
    backgroundColor: FEED_TOKENS.colors.card,
    borderCurve: 'continuous',
  },
  lead: {
    color: FEED_TOKENS.colors.text,
    fontSize: 15,
    lineHeight: 22,
    marginTop: 12,
  },
  sectionLabel: {
    color: FEED_TOKENS.colors.textFaint,
    fontFamily: monoFontFamily(),
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '700',
    letterSpacing: 1,
    marginTop: 24,
    marginBottom: 12,
  },
  articleBody: {
    gap: 12,
  },
  articleHeading: {
    color: FEED_TOKENS.colors.text,
    fontSize: 18,
    lineHeight: 23,
    fontWeight: '700',
  },
  articleText: {
    color: FEED_TOKENS.colors.textDim,
    fontSize: 15,
    lineHeight: 22,
  },
  bulletList: {
    gap: 8,
  },
  bulletRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  bulletMarker: {
    color: FEED_TOKENS.colors.accent,
    fontSize: 15,
    lineHeight: 22,
  },
  bulletText: {
    flex: 1,
  },
  stateCard: {
    borderRadius: FEED_TOKENS.radius.card,
    borderWidth: 1,
    borderColor: FEED_TOKENS.colors.border,
    backgroundColor: FEED_TOKENS.colors.card,
    padding: 16,
    gap: 8,
    marginTop: 24,
  },
  stateTitle: {
    color: FEED_TOKENS.colors.text,
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '700',
  },
  stateText: {
    color: FEED_TOKENS.colors.textDim,
    fontSize: 12,
    lineHeight: 18,
  },
  loadingText: {
    color: FEED_TOKENS.colors.textDim,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 16,
  },
});