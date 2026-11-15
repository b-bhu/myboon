/**
 * Polymarket body for the shared action panel — UI shim.
 *
 * All logic lives in polymarket.action-core.ts (PURE, node-safe); this file
 * owns the react-native surface only: venue inputs (composer mode, limit
 * price) and re-exports so screens can keep importing './polymarket.action'.
 */

import { StyleSheet, Text, TextInput, View } from 'react-native';

import { Segmented } from '@/features/markets/action/Segmented';
import { tokens } from '@/theme/tokens';

import type { PolymarketActionBody as PolymarketActionBodyType } from './polymarket.action-core';

export { createPolymarketActionAdapter } from './polymarket.action-core';
export type { PolymarketActionDeps } from './polymarket.action-core';

/** Venue inputs: composer mode + limit price. The shell owns the amount field. */
export function PolymarketActionInputs({
  body,
  patch,
}: {
  body: PolymarketActionBodyType;
  patch: (next: Partial<PolymarketActionBodyType>) => void;
}) {
  return (
    <View style={styles.stack}>
      <Segmented
        value={body.mode}
        options={[
          { key: 'market', label: 'Market' },
          { key: 'limit', label: 'Limit' },
        ]}
        onChange={(mode) => patch({ mode: mode as 'market' | 'limit' })}
      />
      {body.mode === 'limit' ? (
        <View style={styles.priceRow}>
          <Text style={styles.priceLabel}>Limit price (¢)</Text>
          <TextInput
            style={styles.priceInput}
            value={body.limitPriceCentsText}
            onChangeText={(text) => patch({ limitPriceCentsText: text })}
            keyboardType="decimal-pad"
            placeholder="57"
            placeholderTextColor={tokens.colors.textDim}
            accessibilityLabel="Limit price"
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 14 },
  priceRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: tokens.colors.borderMuted,
  },
  priceLabel: { color: tokens.colors.textDim, fontSize: 13 },
  priceInput: {
    color: tokens.colors.bone,
    fontSize: 15,
    fontFamily: 'monospace',
    textAlign: 'right',
    minWidth: 120,
    paddingVertical: 10,
  },
});

export type PolymarketActionBody = PolymarketActionBodyType;
