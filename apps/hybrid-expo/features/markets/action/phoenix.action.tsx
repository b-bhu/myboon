/**
 * Phoenix body for the shared action panel — UI shim.
 *
 * All logic lives in phoenix.action-core.ts (PURE, node-safe); this file owns
 * the react-native surface only: venue inputs (side, order type, limit price)
 * and re-exports so screens can keep importing from './phoenix.action'.
 */

import { StyleSheet, Text, TextInput, View } from 'react-native';

import type {
  ActionVenueAdapter,
} from '@/features/markets/action/action.contract';
import { Segmented } from '@/features/markets/action/Segmented';
import { tokens } from '@/theme/tokens';

import type { PhoenixActionBody as PhoenixActionBodyType } from './phoenix.action-core';

export {
  createPhoenixActionAdapter,
} from './phoenix.action-core';
export type { PhoenixActionDeps } from './phoenix.action-core';

/** Venue inputs: side, order type, limit price. The shell owns the amount field. */
export function PhoenixActionInputs({
  body,
  patch,
}: {
  body: PhoenixActionBodyType;
  patch: (patch: Partial<PhoenixActionBodyType>) => void;
}) {
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
      <Segmented
        value={body.amountMode}
        options={[
          { key: 'usd', label: 'USD' },
          { key: 'base', label: 'SOL' },
        ]}
        onChange={(amountMode) => patch({ amountMode: amountMode as 'usd' | 'base' })}
      />
      {body.orderType === 'limit' ? (
        <View style={styles.limitRow}>
          <Text style={styles.limitLabel}>Limit price</Text>
          <TextInput
            style={styles.limitValue}
            value={body.limitPriceText}
            onChangeText={(text) => patch({ limitPriceText: text })}
            keyboardType="decimal-pad"
            placeholder="0"
            placeholderTextColor={tokens.colors.textDim}
            accessibilityLabel="Limit price"
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 10 },
  limitRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: tokens.colors.borderMuted,
  },
  limitLabel: { color: tokens.colors.textDim, fontSize: 13 },
  limitValue: { color: tokens.colors.bone, fontSize: 15, fontFamily: 'monospace' },
});

export type PhoenixActionBody = PhoenixActionBodyType;
