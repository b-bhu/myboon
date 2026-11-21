/**
 * useKeyboardLift — raise the sheet above the on-screen keyboard.
 *
 * Moved out of ConnectionSheet.tsx (#737). On iOS a shared value is driven by
 * the willShow/willHide events so the sheet follows the keyboard frame; other
 * platforms only flip the lifted flag, which the sheet uses for its paddings.
 *
 * Model: docs/modules/wallet/specs/wallet_connectivity.md ("The connection modal")
 */

import { useEffect, useRef, useState } from 'react';
import { Animated, Keyboard, Platform } from 'react-native';

export function useKeyboardLift() {
  const keyboardLift = useRef(new Animated.Value(0)).current;
  const [lifted, setLifted] = useState(false);

  useEffect(() => {
    if (Platform.OS !== 'ios') return;

    const onShow = Keyboard.addListener('keyboardWillShow', (event) => {
      setLifted(true);
      Animated.timing(keyboardLift, {
        toValue: event.endCoordinates.height,
        duration: event.duration || 250,
        useNativeDriver: true,
      }).start();
    });

    const onHide = Keyboard.addListener('keyboardWillHide', (event) => {
      Animated.timing(keyboardLift, {
        toValue: 0,
        duration: event.duration || 250,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) setLifted(false);
      });
    });

    return () => {
      onShow.remove();
      onHide.remove();
    };
  }, [keyboardLift]);

  useEffect(() => {
    if (Platform.OS === 'ios') return;
    const onShow = Keyboard.addListener('keyboardDidShow', () => setLifted(true));
    const onHide = Keyboard.addListener('keyboardDidHide', () => setLifted(false));
    return () => {
      onShow.remove();
      onHide.remove();
    };
  }, []);

  return { keyboardLift, lifted, setLifted };
}
