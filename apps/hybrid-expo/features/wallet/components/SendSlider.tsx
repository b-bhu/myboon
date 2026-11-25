/**
 * SendSlider — the Send mode's slider (issue #825, frames "Send · empty",
 * "Send", "Send · in progress", "Send · done", "Send · failed").
 *
 * Ready and failed reuse Swap's `SwipeToConfirm` unchanged: the same swipe,
 * with Send's words passed in as an idle line (a failed send is retried by
 * sliding again — the frame says "Slide to retry"). Off, pending and done are
 * static 54-tall tracks with the same shape.
 */

import { StyleSheet, Text, View } from 'react-native';
import { SwipeToConfirm } from '@/features/swap/components/SwipeToConfirm';
import { swapTheme } from '@/features/swap/swap.theme';
import {
  SEND_USDC_MINT,
  SEND_USDC_DECIMALS,
  sendSliderCopy,
  type SendSliderInput,
} from '@/features/wallet/send-panel.state';

const USDC = { address: SEND_USDC_MINT, symbol: 'USDC', name: 'USD Coin', decimals: SEND_USDC_DECIMALS };

export function SendSlider({ input, onSwipe }: { input: SendSliderInput; onSwipe: () => void }) {
  const copy = sendSliderCopy(input);
  const swipeable = input.stage === 'failed' || (input.stage === 'idle' && input.ready);
  if (swipeable) {
    return (
      <SwipeToConfirm
        key={input.stage}
        receiveAmount={`${input.amount}|${input.address}`}
        outputToken={USDC}
        onComplete={onSwipe}
        slider={{ state: 'idle', route: copy.small, action: copy.strong }}
      />
    );
  }
  const done = input.stage === 'done';
  return (
    <View
      accessible
      accessibilityLabel={copy.strong}
      accessibilityState={{ disabled: !done, busy: input.stage === 'pending' }}
      style={[styles.track, done && styles.done, input.stage === 'idle' && styles.off]}
    >
      <Text style={styles.small} numberOfLines={1}>
        {copy.small}
      </Text>
      <Text style={[styles.strong, done && styles.strongDone]} numberOfLines={1}>
        {copy.strong}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    height: 54,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: swapTheme.gold,
    backgroundColor: swapTheme.navy,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
  },
  off: { borderColor: swapTheme.border },
  done: { borderColor: swapTheme.positive },
  small: { fontSize: 10, fontWeight: '500', color: swapTheme.dim },
  strong: { fontSize: 12, fontWeight: '700', color: swapTheme.text },
  strongDone: { color: swapTheme.positive },
});
