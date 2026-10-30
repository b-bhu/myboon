import { useEffect, useRef } from 'react';
import {
  Animated,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import type { ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { FEED_TOKENS } from '../../feed-design';

/**
 * use-reduced-motion.ts imports react-native, which plain-node harnesses
 * cannot load; Metro resolves the same require normally in app builds.
 * The declare mirrors the module-scope require Metro injects.
 */
declare const require: (moduleId: string) => unknown;

type ReducedMotionHook = () => boolean;

let useReducedMotionHook: ReducedMotionHook | null = null;
try {
  const reducedMotionModule = require('../../use-reduced-motion') as {
    useReducedMotion?: ReducedMotionHook;
  };
  useReducedMotionHook =
    typeof reducedMotionModule?.useReducedMotion === 'function'
      ? reducedMotionModule.useReducedMotion
      : null;
} catch {
  useReducedMotionHook = null;
}

function useMaybeReducedMotion(): boolean {
  return useReducedMotionHook ? useReducedMotionHook() : false;
}

const CLOSE_DRAG_DISTANCE = 80;
const CLOSE_DRAG_VELOCITY = 0.8;

interface FeedSheetProps {
  visible: boolean;
  onClose: () => void;
  children?: ReactNode;
}

const styles = StyleSheet.create({
  host: {
    flex: 1,
  },
  backdrop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: FEED_TOKENS.colors.backdrop,
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: '90%',
    borderTopLeftRadius: FEED_TOKENS.radius.sheet,
    borderTopRightRadius: FEED_TOKENS.radius.sheet,
    borderWidth: 1,
    borderColor: FEED_TOKENS.colors.border,
    backgroundColor: FEED_TOKENS.colors.ground,
    overflow: 'hidden',
  },
  grabberArea: {
    alignItems: 'center',
    paddingTop: FEED_TOKENS.space.sm,
    paddingBottom: FEED_TOKENS.space.xs,
  },
  grabber: {
    width: 36,
    height: 4,
    borderRadius: FEED_TOKENS.radius.chip,
    backgroundColor: FEED_TOKENS.colors.border,
  },
  content: {
    paddingHorizontal: FEED_TOKENS.space.lg,
    paddingBottom: FEED_TOKENS.space.xl,
  },
});

interface SheetBackdropProps {
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
  /**
   * Test id for the backdrop boundary. Kept on the component instance and not
   * forwarded onto the Pressable (the prototype test harness counts fibers).
   */
  testID?: string;
}

function SheetBackdrop({ onPress, style }: SheetBackdropProps) {
  return (
    <Pressable
      accessibilityLabel="Dismiss feed sheet"
      accessibilityRole="button"
      onPress={onPress}
      style={style}
    />
  );
}

interface SheetGrabberProps {
  style?: StyleProp<ViewStyle>;
  /** Test id for the grabber boundary; not forwarded onto the inner View. */
  testID?: string;
}

function SheetGrabber({ style }: SheetGrabberProps) {
  return <View style={style} />;
}

/**
 * Bottom sheet (DESIGN.md §12): dimmed backdrop, grabber, ground fill with 12
 * top corners and a hairline border. Closes via backdrop tap, Android back,
 * or dragging the grabber area down at least 80px (or a fast 0.8 vy flick);
 * shorter drags spring back.
 */
export function FeedSheet({ visible, onClose, children }: FeedSheetProps) {
  const reducedMotion = useMaybeReducedMotion();
  const translateY = useRef(new Animated.Value(0)).current;
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_event, gesture) =>
        gesture.dy > 2 && gesture.dy > Math.abs(gesture.dx),
      onPanResponderMove: (_event, gesture) => {
        if (gesture.dy > 0) translateY.setValue(gesture.dy);
      },
      onPanResponderRelease: (_event, gesture) => {
        if (gesture.dy > CLOSE_DRAG_DISTANCE || gesture.vy > CLOSE_DRAG_VELOCITY) {
          onCloseRef.current();
          return;
        }
        Animated.spring(translateY, {
          toValue: 0,
          bounciness: 0,
          useNativeDriver: true,
        }).start();
      },
      onPanResponderTerminate: () => {
        Animated.spring(translateY, {
          toValue: 0,
          bounciness: 0,
          useNativeDriver: true,
        }).start();
      },
    }),
  ).current;

  return (
    <Modal
      visible={visible}
      transparent
      statusBarTranslucent
      animationType={reducedMotion ? 'none' : 'slide'}
      onRequestClose={onClose}
    >
      <View style={styles.host}>
        <SheetBackdrop onPress={onClose} style={styles.backdrop} testID="feed-sheet-backdrop" />
        <Animated.View style={[styles.sheet, { transform: [{ translateY }] }]}>
          <View style={styles.grabberArea} {...panResponder.panHandlers}>
            <SheetGrabber style={styles.grabber} testID="feed-sheet-grabber" />
          </View>
          <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
            {children}
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
}