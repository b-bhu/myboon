import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Image } from 'expo-image';
import { Animated, Modal, PanResponder, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { TakeActionApps } from '@/features/feed/components/TakeActionApps';
import { FEED_TOKENS, monoFontFamily } from '@/features/feed/feed-design';
import { newsSheetHeight, shouldDismissSheet, sheetBodyDragClaims, updateTimeAgo } from '@/features/feed/feed-updates';
import { useReducedMotion } from '../use-reduced-motion';

export interface NarrativeSheetItem {
  id: string;
  title: string;
  summary: string;
  createdAt: string;
  imageUrl?: string | null;
  imageKind?: 'content' | 'source_avatar' | null;
  imageAttribution?: string | null;
  /**
   * The meta line's halves (mock 'Bitcoin · Macro' / '2h ago · MyBoon', #798):
   * left is the topic · category, right the age · source. Whichever half the
   * update lacks is omitted, never filled with placeholder text.
   */
  topic?: string | null;
  category?: string | null;
  sourceName?: string | null;
  /**
   * The boxed Key points rows (mock #s-todaysheet .kp, #798). The API sends no
   * figure list yet, so the block stays out until that data exists.
   */
  keyPoints?: readonly string[];
  howWeGotHere?: string;
  whatToWatch?: string;
}

interface NarrativeSheetProps {
  item: NarrativeSheetItem | null;
  onClose: () => void;
}

export function NarrativeSheet({ item, onClose }: NarrativeSheetProps) {
  const reducedMotion = useReducedMotion();
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const { height: screenHeight } = useWindowDimensions();
  const sheetHeight = newsSheetHeight(screenHeight);
  const translateY = useRef(new Animated.Value(1000)).current;
  const dragY = useRef(new Animated.Value(0)).current;
  // The article scroll offset gates the body drag: swiping down only closes
  // the sheet while the article sits at its top (the grabber always drags).
  const scrollAtTopRef = useRef(true);

  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    setFailedImage(null);
    scrollAtTopRef.current = true;
  }, [item?.id]);

  useEffect(() => {
    dragY.setValue(0);
    Animated.timing(translateY, {
      toValue: item ? 0 : sheetHeight,
      duration: reducedMotion ? 0 : item ? 260 : 220,
      useNativeDriver: true,
    }).start();
  }, [item, sheetHeight, translateY, dragY, reducedMotion]);

  const settle = useCallback(() => {
    if (reducedMotion) {
      Animated.timing(dragY, { toValue: 0, duration: 0, useNativeDriver: true }).start();
    } else {
      Animated.spring(dragY, { toValue: 0, bounciness: 0, useNativeDriver: true }).start();
    }
  }, [dragY, reducedMotion]);

  // The grabber claims any outward drag; the article claims only at scroll
  // top, so a drag inside a scrolled article keeps scrolling (#798). The
  // drag-release decision stays shouldDismissSheet for both. Swiping down
  // anywhere on the sheet body (or the grabber) closes it, never an upward
  // or sideways drag.
  const release = useCallback((_event: unknown, gesture: { dy: number; vy: number }) => {
    if (shouldDismissSheet(Math.max(0, gesture.dy), gesture.vy, sheetHeight)) {
      onCloseRef.current();
      return;
    }
    settle();
  }, [settle, sheetHeight]);
  const grabberPanResponder = useMemo(
    () => PanResponder.create({
      onMoveShouldSetPanResponder: (_event, gesture) => sheetBodyDragClaims(gesture.dy, gesture.dx),
      onPanResponderMove: (_event, gesture) => {
        dragY.setValue(Math.max(0, gesture.dy));
      },
      onPanResponderRelease: release,
      onPanResponderTerminate: settle,
    }),
    [dragY, release, settle],
  );
  const scrollPanResponder = useMemo(
    () => PanResponder.create({
      onMoveShouldSetPanResponder: (_event, gesture) =>
        scrollAtTopRef.current && sheetBodyDragClaims(gesture.dy, gesture.dx),
      onPanResponderMove: (_event, gesture) => {
        dragY.setValue(Math.max(0, gesture.dy));
      },
      onPanResponderRelease: release,
      onPanResponderTerminate: settle,
    }),
    [dragY, release, settle],
  );

  const title = item?.title ?? '';
  const publishedAt = item?.createdAt ?? '';
  const imageUrl = item?.imageUrl ?? null;
  const showImage = Boolean(imageUrl)
    && item?.imageKind !== 'source_avatar'
    && failedImage !== imageUrl;
  const metaTopic = [item?.topic, item?.category].filter(Boolean).join(' · ');
  const metaWhen = [updateTimeAgo(publishedAt, new Date()), item?.sourceName ?? '']
    .filter(Boolean).join(' · ');
  const fullPicture = (['howWeGotHere', 'whatToWatch'] as const)
    .map((key) => item?.[key]?.trim() ?? '');

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
        <View style={styles.grabberArea} {...grabberPanResponder.panHandlers}>
          <View style={styles.grabber} />
        </View>

        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.content}
          contentOffset={{ x: 0, y: 0 }}
          scrollEventThrottle={16}
          onScroll={(event) => { scrollAtTopRef.current = event.nativeEvent.contentOffset.y <= 0; }}
          {...scrollPanResponder.panHandlers}
        >
          {metaTopic || metaWhen ? (
            <View style={styles.metaRow}>
              {metaTopic ? <Text style={styles.metaTopic}>{metaTopic}</Text> : null}
              {metaWhen ? <Text style={styles.metaWhen}>{metaWhen}</Text> : null}
            </View>
          ) : null}
          <Text style={styles.title}>{title}</Text>
          {showImage && imageUrl ? (
            <Image
              source={imageUrl}
              onError={() => setFailedImage(imageUrl)}
              style={styles.heroImage}
              contentFit="cover"
              transition={reducedMotion ? 0 : 180}
              accessibilityLabel={item?.imageAttribution ?? title}
            />
          ) : null}
          {item?.summary?.trim() ? <Text style={styles.lead}>{item.summary.trim()}</Text> : null}
          {item?.keyPoints?.length ? (
            <View style={styles.keyPoints}>
              <Text style={styles.keyPointsLabel}>Key points</Text>
              {item.keyPoints.map((row, index) => (
                <View key={`${index}-${row}`} style={index > 0 ? styles.keyPointRow : styles.keyPointFirst}>
                  <Text style={styles.keyPointText}>{row}</Text>
                </View>
              ))}
            </View>
          ) : null}
          {fullPicture.some(Boolean) ? (
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>The full picture</Text>
              {fullPicture.map((paragraph, index) => (
                paragraph ? <Text key={`${index}-${paragraph.slice(0, 24)}`} style={styles.body}>{paragraph}</Text> : null
              ))}
            </View>
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
    // The mock's hairline grabber (#798): #185A70, the border token.
    backgroundColor: FEED_TOKENS.colors.border,
  },
  content: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 32,
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: 12,
    marginTop: 12,
    marginBottom: 6,
  },
  metaTopic: {
    flexShrink: 1,
    color: FEED_TOKENS.colors.text,
    fontFamily: monoFontFamily(),
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  metaWhen: {
    color: FEED_TOKENS.colors.textDim,
    fontFamily: monoFontFamily(),
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  title: {
    color: FEED_TOKENS.colors.text,
    fontSize: FEED_TOKENS.type.title,
    lineHeight: 33,
    fontWeight: '700',
    marginTop: 8,
  },
  heroImage: {
    width: '100%',
    height: 150,
    borderRadius: FEED_TOKENS.radius.card,
    borderWidth: 1,
    borderColor: FEED_TOKENS.colors.border,
    marginTop: 12,
    backgroundColor: FEED_TOKENS.colors.card,
    borderCurve: 'continuous',
  },
  lead: {
    color: FEED_TOKENS.colors.text,
    fontSize: 17,
    lineHeight: 25,
    marginTop: 8,
  },
  keyPoints: {
    borderWidth: 1,
    borderColor: FEED_TOKENS.colors.border,
    borderRadius: FEED_TOKENS.radius.card,
    padding: FEED_TOKENS.space.md,
    marginTop: 12,
  },
  keyPointsLabel: {
    color: FEED_TOKENS.colors.textFaint,
    fontFamily: monoFontFamily(),
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  keyPointFirst: {
    marginTop: 8,
    paddingVertical: 6,
  },
  keyPointRow: {
    marginTop: 8,
    paddingVertical: 6,
    borderTopWidth: 1,
    borderTopColor: FEED_TOKENS.colors.border,
  },
  keyPointText: {
    color: FEED_TOKENS.colors.text,
    fontSize: 15,
    lineHeight: 22,
  },
  section: {
    marginTop: 24,
    gap: 8,
  },
  sectionLabel: {
    color: FEED_TOKENS.colors.textFaint,
    fontFamily: monoFontFamily(),
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  body: {
    color: FEED_TOKENS.colors.textDim,
    fontSize: 15,
    lineHeight: 23,
  },
});
