/**
 * ChainRow — one active chain on the Wallet surface: address and balance.
 *
 * Only active chains reach this component. A dormant chain has no wallet and no
 * address, so it is filtered out by the caller rather than rendered in a
 * placeholder state (spec, "Dormancy").
 *
 * The address is a *public* address, and copying it is safe and expected — this
 * is unrelated to the private-key clipboard path being removed separately.
 *
 * Balance is `number | null`. Null renders an explicit unavailable marker, never
 * a fabricated `$0` — a zero we did not measure is a lie about the user's money.
 *
 * Model: docs/modules/wallet/specs/wallet_connectivity.md ("The Wallet surface")
 */

import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import type { Chain } from '@/features/chain/chain.contract';
import { semantic, tokens } from '@/theme';

const CHAIN_LABEL: Record<Chain, string> = {
  solana: 'Solana',
  evm: 'Polygon',
};

const CHAIN_COLOR: Record<Chain, string> = {
  solana: semantic.text.primary,
  evm: tokens.walletBrand.pacifica,
};

const CHAIN_TINT: Record<Chain, string> = {
  solana: 'rgba(6,51,67,0.45)',
  evm: 'rgba(97,215,239,0.07)',
};

function SolanaMark() {
  return (
    <Svg width={18} height={16} viewBox="0 0 26 23" accessibilityElementsHidden>
      <Path
        fill={semantic.text.primary}
        d="m25.033 17.458-4.087 4.382a.95.95 0 0 1-.692.302H.879a.476.476 0 0 1-.348-.798l4.082-4.382a.95.95 0 0 1 .692-.302H24.68a.473.473 0 0 1 .353.798m-4.087-8.827a.96.96 0 0 0-.692-.302H.879a.475.475 0 0 0-.348.798l4.082 4.385a.96.96 0 0 0 .692.302H24.68a.476.476 0 0 0 .346-.798zM.879 5.483h19.375a.95.95 0 0 0 .692-.302L25.033.798a.475.475 0 0 0-.09-.724A.47.47 0 0 0 24.68 0H5.305a.95.95 0 0 0-.692.302L.531 4.685a.475.475 0 0 0 .348.798"
      />
    </Svg>
  );
}

function truncateAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}···${address.slice(-4)}`;
}

function formatUsd(value: number): string {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function ChainRow({
  chain,
  address,
  balanceUsd,
  balanceUnavailableLabel,
  onDisconnect,
}: {
  chain: Chain;
  address: string;
  /** Resolved USD balance, or null when no balance source has resolved. */
  balanceUsd: number | null;
  /** Shown in place of a figure when `balanceUsd` is null. */
  balanceUnavailableLabel?: string;
  onDisconnect: (chain: Chain) => void;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    await Clipboard.setStringAsync(address);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [address]);

  return (
    <View style={[styles.row, { backgroundColor: CHAIN_TINT[chain] }]}>
      <View style={styles.main}>
        <View style={styles.chainHeading}>
          {chain === 'solana' ? <SolanaMark /> : null}
          <Text style={[styles.name, { color: CHAIN_COLOR[chain] }]}>{CHAIN_LABEL[chain]}</Text>
        </View>
        <Pressable
          onPress={handleCopy}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={`Copy ${CHAIN_LABEL[chain]} address`}
          style={({ pressed }) => [styles.addressRow, pressed && styles.pressed]}
        >
          <Text style={styles.address}>{truncateAddress(address)}</Text>
          <MaterialIcons
            name={copied ? 'check' : 'content-copy'}
            size={12}
            color={copied ? tokens.colors.viridian : semantic.text.faint}
          />
        </Pressable>
      </View>

      <View style={styles.trailing}>
        {balanceUsd !== null ? (
          <Text style={styles.balance}>{formatUsd(balanceUsd)}</Text>
        ) : (
          <Text style={styles.balanceUnavailable}>{balanceUnavailableLabel ?? '—'}</Text>
        )}
        <Pressable
          onPress={() => onDisconnect(chain)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={`Disconnect ${CHAIN_LABEL[chain]}`}
          style={({ pressed }) => [styles.disconnectBtn, pressed && styles.pressed]}
        >
          <Text style={styles.disconnectText}>Disconnect</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacing.md,
    borderRadius: tokens.radius.md,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.md,
    minHeight: 64,
  },
  main: {
    flex: 1,
    minWidth: 0,
    gap: tokens.spacing.xs,
  },
  chainHeading: {
    minHeight: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  name: {
    fontSize: tokens.fontSize.md,
    fontWeight: '700',
  },
  addressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: tokens.spacing.xs,
    alignSelf: 'flex-start',
    minHeight: 24,
  },
  address: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.sm,
    color: semantic.text.dim,
  },
  trailing: {
    alignItems: 'flex-end',
    gap: tokens.spacing.xs,
  },
  balance: {
    fontSize: tokens.fontSize.md,
    fontWeight: '700',
    color: semantic.text.primary,
  },
  balanceUnavailable: {
    fontSize: tokens.fontSize.sm,
    color: semantic.text.faint,
  },
  disconnectText: {
    fontSize: tokens.fontSize.sm,
    color: tokens.colors.vermillion,
  },
  disconnectBtn: {
    minHeight: 24,
    justifyContent: 'center',
  },
  pressed: {
    opacity: 0.7,
  },
});
