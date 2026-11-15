/**
 * DESIGN.md §11 swipe-to-confirm — shared, venue-agnostic control.
 *
 * "Used for every trade and send. Outline track (52 tall, 6 corners) in the
 * context accent; solid square knob (44) with an arrow; label states the
 * action and amount. Track fills faintly behind the knob as it moves; release
 * before the end snaps back. Completion fires the confirm haptic."
 *
 * Ported from `features/swap/components/SwipeToConfirm.tsx` (same PanResponder
 * gesture, 0.82 threshold, spring reset) so swap and the action panel share one
 * gesture and one haptic. Swap keeps its own file: its props stay typed to
 * SwapToken and its chrome is swap-themed; untangling that is D2's business.
 */

import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  AccessibilityActionEvent,
  Animated,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import type { ActionAccent } from '@/features/markets/action/action.contract';
import { tokens } from '@/theme/tokens';

const THUMB_SIZE = 44;
const THUMB_INSET = 3;
const THUMB_RADIUS = 4;
const TRACK_HEIGHT = 52;
const COMPLETE_FRACTION = 0.82;

export const actionAccentColor: Record<ActionAccent, string> = {
  pos: tokens.colors.viridian,
  neg: tokens.colors.vermillion,
  accent: tokens.colors.accent,
};

export function SwipeToConfirm({
  label,
  accent,
  disabled = false,
  onComplete,
  testID,
}: {
  label: string;
  accent: ActionAccent;
  disabled?: boolean;
  onComplete: () => void;
  testID?: string;
}) {
  const accentColor = actionAccentColor[accent];
  const translateX = useRef(new Animated.Value(0)).current;
  const maxTravelRef = useRef(0);
  const completedRef = useRef(false);
  const mountedRef = useRef(true);

  const reset = useCallback(() => {
    completedRef.current = false;
    Animated.spring(translateX, {
      toValue: 0,
      speed: 28,
      bounciness: 4,
      useNativeDriver: false,
    }).start();
  }, [translateX]);

  const complete = useCallback(() => {
    if (disabled) return;
    if (completedRef.current || maxTravelRef.current <= 0) return;
    completedRef.current = true;
    Animated.timing(translateX, {
      toValue: maxTravelRef.current,
      duration: 150,
      useNativeDriver: false,
    }).start(({ finished }) => {
      if (finished && mountedRef.current) {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => null);
        onComplete();
      }
    });
  }, [disabled, onComplete, translateX]);

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_, gesture) =>
          !disabled &&
          maxTravelRef.current > 0 &&
          gesture.dx > 5 &&
          Math.abs(gesture.dx) > Math.abs(gesture.dy),
        onPanResponderTerminationRequest: () => true,
        onPanResponderMove: (_, gesture) => {
          if (!completedRef.current)
            translateX.setValue(Math.max(0, Math.min(maxTravelRef.current, gesture.dx)));
        },
        onPanResponderRelease: (_, gesture) => {
          if (gesture.dx >= maxTravelRef.current * COMPLETE_FRACTION) complete();
          else reset();
        },
        onPanResponderTerminate: reset,
      }),
    [complete, disabled, reset, translateX],
  );

  useEffect(() => {
    mountedRef.current = true;
    completedRef.current = false;
    translateX.setValue(0);
    return () => {
      mountedRef.current = false;
      translateX.stopAnimation();
    };
  }, [label, disabled, translateX]);

  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      maxTravelRef.current = Math.max(
        0,
        event.nativeEvent.layout.width - THUMB_SIZE - THUMB_INSET * 2,
      );
      completedRef.current = false;
      translateX.setValue(0);
    },
    [translateX],
  );

  const onAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      if (event.nativeEvent.actionName === 'activate') complete();
    },
    [complete],
  );

  return (
    <Pressable
      accessible
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="Review the details above, then swipe right to confirm"
      accessibilityActions={[{ name: 'activate', label: 'Confirm' }]}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onAccessibilityAction={onAccessibilityAction}
      onLayout={onLayout}
      style={[styles.track, { borderColor: accentColor }, disabled && styles.trackDisabled]}
      testID={testID}
      {...(disabled ? null : responder.panHandlers)}
    >
      <Animated.View style={[styles.fill, {
        backgroundColor: accentColor,
        width: Animated.add(translateX, THUMB_SIZE + THUMB_INSET * 2),
        opacity: 0.12,
      }]} />
      <View pointerEvents="none" style={styles.copy}>
        <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8} style={styles.label}>
          {label}
        </Text>
      </View>
      <Animated.View style={[styles.thumb, { backgroundColor: accentColor }, { transform: [{ translateX }] }]}>
        <MaterialIcons name="chevron-right" size={22} color={tokens.colors.walletCore} />
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  track: {
    position: 'relative',
    height: TRACK_HEIGHT,
    overflow: 'hidden',
    borderWidth: 1,
    borderRadius: 6,
    borderCurve: 'continuous',
    backgroundColor: tokens.colors.ground,
  },
  trackDisabled: { opacity: 0.5 },
  fill: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
  },
  copy: {
    ...StyleSheet.absoluteFillObject,
    paddingLeft: THUMB_SIZE + THUMB_INSET * 2,
    paddingRight: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    fontSize: 13,
    lineHeight: 16,
    color: tokens.colors.bone,
    fontWeight: '600',
  },
  thumb: {
    position: 'absolute',
    top: THUMB_INSET,
    left: THUMB_INSET,
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: THUMB_RADIUS,
    borderCurve: 'continuous',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
