import { useEffect, useMemo, useRef, useState } from 'react';
import { Image } from 'expo-image';
import { Animated, Linking, Modal, PanResponder, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { TakeActionApps } from '@/features/feed/components/TakeActionApps';
import { FEED_TOKENS, monoFontFamily } from '@/features/feed/feed-design';
import { newsSheetHeight, shouldDismissSheet, updateAge } from '@/features/feed/feed-updates';
import type { FeedUpdateSource } from '@/features/feed/feed.types';
import { useReducedMotion } from '../use-reduced-motion';

export interface NarrativeSheetItem {
  id: string;
  title: string;
  summary: string;
  createdAt: string;
  imageUrl?: string | null;
  imageKind?: 'content' | 'source_avatar' | null;
  imageAttribution?: string | null;
  howWeGotHere?: string;
  whatToWatch?: string;
  sources?: readonly FeedUpdateSource[];
}

interface NarrativeSheetProps {
  item: NarrativeSheetItem | null;
  onClose: () => void;
}

const BODY: readonly { key: 'summary' | 'howWeGotHere' | 'whatToWatch'; label: string }[] = [
  { key: 'summary', label: 'What happened' },
  { key: 'howWeGotHere', label: 'How we got here' },
  { key: 'whatToWatch', label: 'What to watch' },
];

export function NarrativeSheet({ item, onClose }: NarrativeSheetProps) {
  const reducedMotion = useReducedMotion();
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const { height: screenHeight } = useWindowDimensions();
  const sheetHeight = newsSheetHeight(screenHeight);
  const translateY = useRef(new Animated.Value(1000)).current;
  const dragY = useRef(new Animated.Value(0)).current;

  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    setFailedImage(null);
  }, [item?.id]);

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

  const title = item?.title ?? '';
  const publishedAt = item?.createdAt ?? '';
  const imageUrl = item?.imageUrl ?? null;
  const showImage = Boolean(imageUrl)
    && item?.imageKind !== 'source_avatar'
    && failedImage !== imageUrl;
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
          {BODY.map((section) => {
            const text = item?.[section.key]?.trim();
            if (!text) return null;
            return (
              <View key={section.key} style={styles.section}>
                <Text style={styles.sectionLabel}>{section.label}</Text>
                <Text style={styles.lead}>{text}</Text>
              </View>
            );
          })}
          {item?.sources?.length ? (
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>Sources</Text>
              {item.sources.map((source) => (
                <Pressable
                  key={source.itemId}
                  accessibilityRole="link"
                  accessibilityLabel={source.title}
                  onPress={() => { void Linking.openURL(source.link); }}
                  style={styles.sourceLink}
                >
                  <Text style={styles.sourceTitle}>{source.title}</Text>
                </Pressable>
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
  section: {
    marginTop: 24,
    gap: 8,
  },
  lead: {
    color: FEED_TOKENS.colors.textDim,
    fontSize: 15,
    lineHeight: 22,
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
  sourceLink: {
    minHeight: 44,
    justifyContent: 'center',
  },
  sourceTitle: {
    color: FEED_TOKENS.colors.accent,
    fontSize: 12,
    lineHeight: 16,
  },
});
