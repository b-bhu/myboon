/**
 * DormantChainNotice — a chain the user never activated is holding funds.
 *
 * This should be unreachable. Deferred provisioning means a dormant chain has no
 * wallet and therefore no address that can receive anything. If this renders,
 * deferred creation has failed and the user has money somewhere the Wallet
 * surface would otherwise not show them (spec, "Dormancy").
 *
 * So the copy states the fact plainly rather than apologizing or explaining the
 * bug: the user's concern is their funds, not our provisioning logic. Activating
 * moves the chain to active, after which its balance renders in the normal
 * `ChainRow` and this notice disappears.
 *
 * Styling follows `ChainRow` — `tokens.spacing`, `tokens.radius`, `semantic.*`,
 * proportional type. Deliberately not the drawer's monospace treatment.
 */

import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Chain } from '@/features/chain/chain.contract';
import { semantic, tokens } from '@/theme';

const CHAIN_LABEL: Record<Chain, string> = {
  solana: 'Solana',
  evm: 'Polygon',
};

function formatUsd(value: number): string {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function DormantChainNotice({
  chain,
  balanceUsd,
  onActivate,
}: {
  chain: Chain;
  /** Measured, non-zero. The detection layer never passes null or zero here. */
  balanceUsd: number;
  onActivate: (chain: Chain) => void;
}) {
  const label = CHAIN_LABEL[chain];

  return (
    <View style={styles.notice} accessibilityRole="alert">
      <View style={styles.header}>
        <MaterialIcons
          name="account-balance-wallet"
          size={16}
          color={tokens.colors.accent}
        />
        <Text style={styles.title}>Funds on {label}</Text>
      </View>

      <Text style={styles.body}>
        You have {formatUsd(balanceUsd)} on {label}, which you have not added to
        your wallet yet. Add it to see the balance and use it.
      </Text>

      <Pressable
        onPress={() => onActivate(chain)}
        accessibilityRole="button"
        accessibilityLabel={`Add ${label} to your wallet`}
        style={({ pressed }) => [styles.action, pressed && styles.pressed]}
      >
        <Text style={styles.actionText}>Add {label}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  notice: {
    gap: tokens.spacing.sm,
    borderRadius: tokens.radius.md,
    borderWidth: 1,
    borderColor: 'rgba(255, 209, 102, 0.3)',
    backgroundColor: 'rgba(255, 209, 102, 0.08)',
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.md,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: tokens.spacing.sm,
  },
  title: {
    fontSize: tokens.fontSize.md,
    fontWeight: '700',
    color: semantic.text.primary,
  },
  body: {
    fontSize: tokens.fontSize.sm,
    lineHeight: tokens.lineHeight.body,
    color: semantic.text.dim,
  },
  action: {
    alignSelf: 'flex-start',
    borderRadius: tokens.radius.sm,
    borderWidth: 1,
    borderColor: 'rgba(255, 209, 102, 0.45)',
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
    minHeight: 32,
    justifyContent: 'center',
  },
  actionText: {
    fontSize: tokens.fontSize.sm,
    fontWeight: '700',
    color: tokens.colors.accent,
  },
  pressed: {
    opacity: 0.7,
  },
});
