import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import type { SwapToken } from '@/features/swap/swap.types';
import { swapSliderCopy, type SwapSliderCopyInput } from '@/features/swap/swap.display';
import { swapTheme as color } from '@/features/swap/swap.theme';

const SWIPE_THUMB_SIZE = 42;
const SWIPE_INSET = 4;
const SWIPE_THRESHOLD = 0.82;

export function SwipeToConfirm({
  receiveAmount,
  outputToken,
  onComplete,
  slider,
}: {
  receiveAmount: string;
  outputToken: SwapToken;
  onComplete: () => void;
  /** Slider copy state; defaults to an idle swap derived from the receive amount. */
  slider?: SwapSliderCopyInput;
}) {
  const copy = swapSliderCopy(
    slider ?? {
      state: 'idle',
      action: `Swipe to swap for ${receiveAmount} ${outputToken.symbol}`,
    },
  );
  const [showFees, setShowFees] = useState(false);
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
  }, [onComplete, translateX]);
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_, gesture) =>
          maxTravelRef.current > 0 && gesture.dx > 5 && Math.abs(gesture.dx) > Math.abs(gesture.dy),
        onPanResponderTerminationRequest: () => true,
        onPanResponderMove: (_, gesture) => {
          if (!completedRef.current)
            translateX.setValue(Math.max(0, Math.min(maxTravelRef.current, gesture.dx)));
        },
        onPanResponderRelease: (_, gesture) => {
          if (gesture.dx >= maxTravelRef.current * SWIPE_THRESHOLD) complete();
          else reset();
        },
        onPanResponderTerminate: reset,
      }),
    [complete, reset, translateX],
  );
  useEffect(() => {
    mountedRef.current = true;
    completedRef.current = false;
    setShowFees(false);
    translateX.setValue(0);
    return () => {
      mountedRef.current = false;
      translateX.stopAnimation();
    };
  }, [outputToken.address, receiveAmount, translateX]);
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      maxTravelRef.current = Math.max(
        0,
        event.nativeEvent.layout.width - SWIPE_THUMB_SIZE - SWIPE_INSET * 2,
      );
      completedRef.current = false;
      translateX.setValue(0);
    },
    [translateX],
  );
  return (
    <View
      accessible
      accessibilityRole="button"
      accessibilityLabel={copy.strong}
      accessibilityHint="Review the details above, then swipe right to open your wallet"
      accessibilityActions={[{ name: 'activate', label: 'Open wallet' }]}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === 'activate') complete();
      }}
      onLayout={onLayout}
      style={styles.track}
      {...responder.panHandlers}
    >
      <Animated.View
        style={[
          styles.fill,
          { width: Animated.add(translateX, SWIPE_THUMB_SIZE + SWIPE_INSET * 2) },
        ]}
      />
      <View pointerEvents="none" style={[styles.copy, copy.feeSplit ? styles.copyWithInfo : null]}>
        <Text style={styles.text} numberOfLines={1}>
          {showFees && copy.feeSplit ? copy.feeSplit : copy.small}
        </Text>
        <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.82} style={styles.amount}>
          {copy.strong}
        </Text>
      </View>
      {copy.feeSplit ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={showFees ? 'Hide fee split' : 'Show fee split'}
          accessibilityState={{ expanded: showFees }}
          hitSlop={8}
          onPress={() => setShowFees((value) => !value)}
          style={styles.infoButton}
        >
          <Text style={styles.infoText}>i</Text>
        </Pressable>
      ) : null}
      <Animated.View style={[styles.thumb, { transform: [{ translateX }] }]}>
        <MaterialIcons name="chevron-right" size={24} color={color.navy} />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    position: 'relative',
    height: 54,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: color.gold,
    borderRadius: 10,
    borderCurve: 'continuous',
    backgroundColor: color.navy,
  },
  fill: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'rgba(255,209,102,0.08)',
  },
  copy: {
    ...StyleSheet.absoluteFillObject,
    paddingLeft: 54,
    paddingRight: 10,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
  },
  copyWithInfo: { paddingRight: 30 },
  infoButton: {
    position: 'absolute',
    right: 10,
    top: '50%',
    marginTop: -10,
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: color.dim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  infoText: { color: color.dim, fontSize: 11, fontWeight: '700', fontStyle: 'italic' },
  text: {
    flexShrink: 1,
    color: color.dim,
    fontSize: 10,
    fontWeight: '500',
    textAlign: 'center',
  },
  amount: { fontSize: 12, color: color.text, fontWeight: '700', fontVariant: ['tabular-nums'] },
  avatar: {
    width: 17,
    height: 17,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.gold,
  },
  avatarText: { color: color.text, fontSize: 9, fontWeight: '700' },
  thumb: {
    position: 'absolute',
    top: SWIPE_INSET,
    left: SWIPE_INSET,
    width: SWIPE_THUMB_SIZE,
    height: SWIPE_THUMB_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    borderCurve: 'continuous',
    backgroundColor: color.gold,
  },
});
