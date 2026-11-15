/**
 * Pacifica body for the shared action panel — UI shim.
 *
 * All logic lives in pacifica.action-core.ts (PURE, node-safe); this file owns
 * the react-native surface only: venue inputs (side, order type, limit price,
 * TP/SL) and re-exports so screens can keep importing './pacifica.action'.
 */

import { StyleSheet, Text, TextInput, View } from 'react-native';

import { Segmented } from '@/features/markets/action/Segmented';
import { tokens } from '@/theme/tokens';

import type { PacificaActionBody as PacificaActionBodyType } from './pacifica.action-core';

export { createPacificaActionAdapter } from './pacifica.action-core';
export type { PacificaActionDeps } from './pacifica.action-core';

/** Venue inputs: side, order type, limit price, TP/SL. The shell owns the amount field. */
export function PacificaActionInputs({
  body,
  patch,
}: {
  body: PacificaActionBodyType;
  patch: (patch: Partial<PacificaActionBodyType>) => void;
}) {
  const priceField = (key: 'limitPriceText' | 'tpPriceText' | 'slPriceText', label: string, value: string) => (
    <View key={key} style={styles.priceRow}>
      <Text style={styles.priceLabel}>{label}</Text>
      <TextInput
        style={styles.priceInput}
        value={value}
        onChangeText={(text) => patch({ [key]: text } as Partial<PacificaActionBodyType>)}
        keyboardType="decimal-pad"
        placeholder="0"
        placeholderTextColor={tokens.colors.textDim}
        accessibilityLabel={label}
      />
    </View>
  );
  return (
    <View style={styles.stack}>
      <Segmented
        value={body.side}
        options={[
          { key: 'long', label: 'Long' },
          { key: 'short', label: 'Short' },
        ]}
        onChange={(side) => patch({ side: side as 'long' | 'short' })}
      />
      <Segmented
        value={body.orderType}
        options={[
          { key: 'market', label: 'Market' },
          { key: 'limit', label: 'Limit' },
        ]}
        onChange={(orderType) => patch({ orderType: orderType as 'market' | 'limit' })}
      />
      {body.orderType === 'limit' ? priceField('limitPriceText', 'Limit price', body.limitPriceText) : null}
      {priceField('tpPriceText', 'Take-profit (optional)', body.tpPriceText)}
      {priceField('slPriceText', 'Stop-loss (optional)', body.slPriceText)}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 10 },
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

export type PacificaActionBody = PacificaActionBodyType;
