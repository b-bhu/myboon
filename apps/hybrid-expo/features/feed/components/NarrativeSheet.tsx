import { useEffect, useRef, useState } from 'react';
import { Image } from 'expo-image';
import { Animated, Modal, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { TakeActionApps } from '@/features/feed/components/TakeActionApps';
import { fetchNarrativeDetail, toShortDate } from '@/features/feed/feed.api';
import type { NarrativeDetail } from '@/features/feed/feed.api';
import { FEED_COLORS } from '@/features/feed/feed.constants';

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
  const { height: screenHeight } = useWindowDimensions();
  const sheetHeight = Math.round(screenHeight * 0.88);
  const translateY = useRef(new Animated.Value(1000)).current;
  const [detail, setDetail] = useState<NarrativeDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const itemId = item?.id;

  useEffect(() => {
    Animated.timing(translateY, {
      toValue: item ? 0 : sheetHeight,
      duration: item ? 260 : 220,
      useNativeDriver: true,
    }).start();
  }, [item, sheetHeight, translateY]);

  useEffect(() => {
    let cancelled = false;
    if (!itemId) {
      setDetail(null);
      setError(false);
      return;
    }

    setLoading(true);
    setError(false);
    setDetail(null);
    fetchNarrativeDetail(itemId)
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
  }, [itemId]);

  const title = detail?.title ?? item?.title ?? '';
  const summary = detail?.summary ?? item?.summary ?? '';
  const publishedAt = detail?.publishedAt ?? item?.createdAt ?? '';
  const imageUrl = detail?.imageUrl ?? item?.imageUrl ?? null;
  const imageKind = detail?.imageKind ?? item?.imageKind ?? null;

  return (
    <Modal
      visible={item !== null}
      transparent
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="Close Feed item" />
      <Animated.View style={[styles.sheet, { height: sheetHeight + 16, transform: [{ translateY }] }]}>
        <View style={styles.handle} />
        <View style={styles.sheetHeader}>
          <View style={styles.headerCopy}>
            <Text style={styles.eyebrow}>FULL FEED</Text>
            <Text style={styles.date}>{publishedAt ? toShortDate(publishedAt) : ''}</Text>
          </View>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close Feed item"
            style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}
          >
            <Text style={styles.closeText}>×</Text>
          </Pressable>
        </View>

        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
          {imageUrl && imageKind === 'content' ? (
            <Image
              source={imageUrl}
              style={styles.heroImage}
              contentFit="cover"
              transition={180}
              accessibilityLabel={detail?.imageAttribution ?? item?.imageAttribution ?? title}
            />
          ) : null}
          <Text style={styles.title}>{title}</Text>
          <View style={styles.divider} />
          <Text style={styles.lead}>{summary}</Text>

          {loading ? <Text style={styles.loadingText}>Loading the full Feed item…</Text> : null}
          {error ? (
            <View style={styles.stateCard}>
              <Text style={styles.stateTitle}>Full Feed item unavailable</Text>
              <Text style={styles.stateText}>The shorter update is still available above.</Text>
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
  date: {
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
    fontSize: 24,
    lineHeight: 29,
    fontWeight: '900',
  },
  divider: {
    height: 1,
    marginVertical: 18,
    backgroundColor: FEED_COLORS.border,
  },
  lead: {
    color: '#D7E7EB',
    fontSize: 15,
    lineHeight: 22,
    fontWeight: '800',
  },
  sectionLabel: {
    color: FEED_COLORS.accent,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 1.1,
    marginTop: 26,
    marginBottom: 14,
  },
  articleBody: {
    gap: 14,
  },
  articleHeading: {
    color: FEED_COLORS.text,
    fontSize: 16,
    lineHeight: 23,
    fontWeight: '800',
  },
  articleText: {
    color: FEED_COLORS.textDim,
    fontSize: 14,
    lineHeight: 22,
  },
  bulletList: {
    gap: 10,
  },
  bulletRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 9,
  },
  bulletMarker: {
    color: FEED_COLORS.accent,
    fontSize: 14,
    lineHeight: 22,
  },
  bulletText: {
    flex: 1,
  },
  stateCard: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: FEED_COLORS.border,
    padding: 14,
    gap: 6,
    marginTop: 24,
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
  loadingText: {
    color: FEED_COLORS.textDim,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 22,
  },
  pressed: {
    opacity: 0.72,
  },
});
