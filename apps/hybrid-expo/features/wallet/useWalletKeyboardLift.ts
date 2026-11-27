import { useCallback, useRef } from 'react';
import { useWindowDimensions } from 'react-native';
import type { TextInput, View } from 'react-native';
import type { RefObject } from 'react';
import { runOnJS, useAnimatedReaction, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { walletKeyboardLiftPx } from './keyboard-lift';

/**
 * #805 — the Wallet action panel's keyboard lift.
 *
 * The keyboard's top edge is the live height `react-native-keyboard-controller`
 * reports while it opens, moves and closes (its shared value is negative while
 * the keyboard shows); the slider row and the amount field report their window
 * positions through the refs this hook returns. `walletKeyboardLiftPx` turns
 * both into the overlap, and the returned animated style translates the action
 * panel block by it on the UI thread, so the lift follows the keyboard while it
 * animates and returns the panel to rest when the keyboard closes. No keyboard,
 * screen or slider size is written into the code.
 */

export type WalletKeyboardLift = {
  /** Animated translateY for the action panel block. */
  keyboardLiftStyle: { transform: { translateY: number }[] };
  /** Attach to the slider row so its window position can be measured. */
  sliderRowRef: RefObject<View | null>;
  /** Re-measure whenever the slider row lays out. */
  onSliderRowLayout: () => void;
  /** Attach to the amount field so the lift's cap can see its top edge. */
  amountFieldRef: RefObject<TextInput | null>;
};

export function useWalletKeyboardLift(): WalletKeyboardLift {
  const { height } = useReanimatedKeyboardAnimation();
  const { height: windowHeight } = useWindowDimensions();
  const { top: safeTopY } = useSafeAreaInsets();

  const sliderRowRef = useRef<View | null>(null);
  const amountFieldRef = useRef<TextInput | null>(null);
  // Resting geometry (window coordinates without this hook's lift).
  const sliderRestBottom = useSharedValue(0);
  const amountRestTop = useSharedValue(0);
  // The lift currently applied by this hook's own translateY.
  const appliedLift = useSharedValue(0);

  const measure = useCallback(() => {
    // Both nodes may already carry this hook's own translateY; adding it back
    // reads their resting geometry no matter when the measurement happens.
    const liftedBy = appliedLift.value;
    sliderRowRef.current?.measureInWindow((_x, y, _width, rowHeight) => {
      sliderRestBottom.value = y + rowHeight + liftedBy;
    });
    amountFieldRef.current?.measureInWindow((_x, y, _width, _height) => {
      amountRestTop.value = y + liftedBy;
    });
    // The shared values are stable mounts; listing them keeps exhaustive-deps quiet.
  }, [appliedLift, sliderRowRef, amountFieldRef, sliderRestBottom, amountRestTop]);

  // Measure once when the keyboard starts to open; while it is open only its
  // height changes (which the style recomputes every frame), never the panel's
  // resting geometry. Layout changes while open re-measure via onSliderRowLayout.
  useAnimatedReaction(
    () => height.value < 0,
    (open, previously) => {
      if (open && previously !== true) runOnJS(measure)();
    },
    [measure],
  );

  const onSliderRowLayout = useCallback(() => {
    measure();
  }, [measure]);

  const keyboardLiftStyle = useAnimatedStyle(() => {
    const keyboardHeight = Math.max(0, -height.value);
    const lift = walletKeyboardLiftPx({
      keyboardTopY: windowHeight - keyboardHeight,
      sliderBottomY: sliderRestBottom.value,
      amountTopY: amountRestTop.value,
      safeTopY,
    });
    appliedLift.value = lift;
    return { transform: [{ translateY: -lift }] };
  }, [windowHeight, safeTopY]);

  return { keyboardLiftStyle, sliderRowRef, onSliderRowLayout, amountFieldRef };
}
