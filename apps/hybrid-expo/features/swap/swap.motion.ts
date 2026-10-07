import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated } from 'react-native';

/** A small value reveal, with the system's reduced-motion preference respected. */
export function useSwapValueAnimation(value: string) {
  const [reducedMotion, setReducedMotion] = useState(true);
  const progress = useRef(new Animated.Value(1)).current;
  const previousValue = useRef(value);

  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (mounted) setReducedMotion(enabled);
    });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReducedMotion);
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    progress.stopAnimation();
    const changed = previousValue.current !== value;
    previousValue.current = value;
    if (reducedMotion || !changed || !value) {
      progress.setValue(1);
      return;
    }
    progress.setValue(0);
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: 220,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [value, reducedMotion, progress]);

  return {
    opacity: progress.interpolate({ inputRange: [0, 1], outputRange: [0.72, 1] }),
    transform: [{ translateX: progress.interpolate({ inputRange: [0, 1], outputRange: [4, 0] }) }],
  };
}
