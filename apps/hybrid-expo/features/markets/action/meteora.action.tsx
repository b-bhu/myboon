/**
 * Meteora — shared action panel body (UI half).
 *
 * The venue adapter factory lives in `meteora.action-core.ts` (PURE, so the
 * body is unit-testable without react-native). This module re-exports it
 * and adds the venue-specific Inputs panel. See the core file's head for
 * the full wiring notes: faithful port of MeteoraPoolPhaseTwoScreen's
 * 'position' tab, side-less surface, execution modules untouched.
 */

import { StyleSheet, Text, TextInput, View } from 'react-native';

import { tokens } from '@/theme/tokens';

export {
  buildMeteoraActionDraft,
  createMeteoraActionAdapter,
  EMPTY_METEORA_ACTION_BODY,
} from '@/features/markets/action/meteora.action-core';
export type {
  MeteoraActionBody,
  MeteoraActionDeps,
} from '@/features/markets/action/meteora.action-core';

import type { MeteoraActionBody } from '@/features/markets/action/meteora.action-core';

/** Venue inputs: optional Y-side override. The shell owns the amount field. */
export function MeteoraActionInputs({
  body,
  patch,
}: {
  body: MeteoraActionBody;
  patch: (next: Partial<MeteoraActionBody>) => void;
}) {
  return (
    <View style={styles.stack}>
      <View style={styles.amountYRow}>
        <Text style={styles.amountYLabel}>Y amount (optional)</Text>
        <TextInput
          style={styles.amountYInput}
          value={body.amountYText}
          onChangeText={(text) => patch({ amountYText: text })}
          placeholder="Auto-fill"
          placeholderTextColor={tokens.colors.textDim}
          keyboardType="decimal-pad"
          testID="meteora-action-y-amount"
          accessibilityLabel="Y-side amount"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 14 },
  amountYRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: tokens.colors.borderMuted,
  },
  amountYLabel: { color: tokens.colors.textDim, fontSize: 13 },
  amountYInput: {
    color: tokens.colors.bone,
    fontSize: 15,
    fontFamily: 'monospace',
    textAlign: 'right',
    minWidth: 120,
    paddingVertical: 10,
  },
});
