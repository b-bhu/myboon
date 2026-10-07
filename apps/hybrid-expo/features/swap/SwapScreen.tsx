import { useCallback } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SwapComposer } from '@/features/swap/components/SwapComposer';
import { useSwapController } from '@/features/swap/useSwapController';
import { swapTheme as color } from '@/features/swap/swap.theme';
import type { SwapEntryMode } from '@/features/swap/swap.types';

function modeFrom(value: string | string[] | undefined): SwapEntryMode {
  const item = Array.isArray(value) ? value[0] : value;
  return item === 'buy' || item === 'sell' ? item : 'swap';
}

/** Spot list Buy/Sell and routed Swap use exactly the Wallet composer. */
export default function SwapScreen() {
  const router = useRouter();
  const focused = useIsFocused();
  const params = useLocalSearchParams<{ mode?: string; token?: string }>();
  const insets = useSafeAreaInsets();
  const mode = modeFrom(params.mode);
  const requestedMint = Array.isArray(params.token) ? params.token[0] : params.token;
  const controller = useSwapController({ mode, active: focused, requestedMint });
  const close = useCallback(() => {
    if (controller.interactionBusy && controller.phase !== 'unknown') return;
    router.back();
  }, [controller.interactionBusy, controller.phase, router]);
  const onBusyChange = useCallback(() => {}, []);
  return <KeyboardAvoidingView style={styles.overlay} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
    <Pressable style={styles.backdrop} onPress={close} accessibilityRole="button" accessibilityLabel="Close trade sheet"
      disabled={controller.interactionBusy && controller.phase !== 'unknown'} />
    <View style={[styles.sheet, { marginTop: insets.top + 16, paddingBottom: Math.max(insets.bottom, 12) }]}>
      <Pressable onPress={close} style={styles.close} accessibilityRole="button" accessibilityLabel="Close trade sheet"
        disabled={controller.interactionBusy && controller.phase !== 'unknown'}><Text style={styles.closeText}>Close ×</Text></Pressable>
      <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'} contentContainerStyle={styles.body}>
        <SwapComposer active={focused} surfaceKey={`route:${mode}:${requestedMint ?? ''}`} onBusyChange={onBusyChange}
          controller={controller} walletActions={mode === 'swap'} />
      </ScrollView>
    </View>
  </KeyboardAvoidingView>;
}
const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(3,31,44,0.75)' },
  sheet: { maxHeight: '94%', backgroundColor: color.gold, borderTopLeftRadius: 22, borderTopRightRadius: 22 },
  close: { minHeight: 44, alignSelf: 'flex-end', paddingHorizontal: 18, justifyContent: 'center' },
  closeText: { color: color.navy, fontSize: 13, fontWeight: '600' },
  body: { paddingHorizontal: 14, paddingBottom: 10 },
});
