/**
 * SendPanel — the Wallet's Send mode body (issue #822, design wallet.html
 * frames "Send" and "Send · empty").
 *
 * Card A is the amount (USDC on Solana) with the 25 / 50 / 75 / Max chips
 * under the pair of cards; card B is the address with a Paste button. Launch
 * scope is Solana USDC only. Nothing is validated or signed here: address
 * checks are #823, the slider and signing #824 / #825. The slot where the
 * slider will sit only says what is missing.
 *
 * The chips read the Spot USDC balance from the wallet summary
 * (`useWalletSummary`); with no balance they are disabled but the amount can
 * still be typed. Pure rules: ../send-panel.state.
 */

import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { tokens } from '@/theme';
import { WALLET_ACTION_BODY_HEIGHT } from '@/features/wallet/wallet-mode';
import { useWalletSummary } from '@/features/wallet/useWalletSummary';
import {
  SEND_CHIPS,
  balanceText,
  chipAmountText,
  sanitizeAmountText,
  spotUsdcAtomic,
  type SendChipPercent,
} from '@/features/wallet/send-panel.state';

export function SendPanel({ solanaAddress }: { solanaAddress: string | null }) {
  const { summary } = useWalletSummary(solanaAddress, null);
  const balanceAtomic = spotUsdcAtomic(summary);
  const [amount, setAmount] = useState('');
  const [address, setAddress] = useState('');
  const [activeChip, setActiveChip] = useState<SendChipPercent | null>(null);

  const handleChip = useCallback((percent: SendChipPercent) => {
    if (balanceAtomic === null) return;
    setAmount(chipAmountText(balanceAtomic, percent));
    setActiveChip(percent);
  }, [balanceAtomic]);

  const handleAmount = useCallback((text: string) => {
    setAmount(sanitizeAmountText(text));
    setActiveChip(null);
  }, []);

  const handlePaste = useCallback(async () => {
    const text = await Clipboard.getStringAsync().catch(() => '');
    if (text) setAddress(text.trim());
  }, []);

  const chipsDisabled = balanceAtomic === null;

  return (
    <View style={styles.body}>
      <View style={styles.card}>
        <View style={styles.top}>
          <Text style={styles.cap}>You send</Text>
          {balanceAtomic !== null ? (
            <Text style={styles.cap}>Bal {balanceText(balanceAtomic)}</Text>
          ) : null}
        </View>
        <View style={styles.mid}>
          <View style={styles.pill}>
            <Text style={styles.pillLabel}>USDC</Text>
          </View>
          <TextInput
            value={amount}
            onChangeText={handleAmount}
            placeholder="0"
            placeholderTextColor={tokens.colors.textFaint}
            keyboardType="decimal-pad"
            accessibilityLabel="Amount to send in USDC"
            style={styles.amount}
          />
        </View>
        <Text style={styles.cap}>USDC on Solana</Text>
      </View>

      <View style={styles.card}>
        <View style={styles.top}>
          <Text style={styles.cap}>To</Text>
          <Pressable
            onPress={handlePaste}
            accessibilityRole="button"
            accessibilityLabel="Paste address from clipboard"
            style={({ pressed }) => [styles.mini, pressed && styles.pressed]}
          >
            <Text style={styles.miniLabel}>Paste</Text>
          </Pressable>
        </View>
        <TextInput
          value={address}
          onChangeText={setAddress}
          placeholder="Paste a Solana address"
          placeholderTextColor={tokens.colors.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="Recipient Solana address"
          style={styles.address}
        />
        <Text style={styles.cap}>Solana address</Text>
      </View>

      <View style={[styles.chips, chipsDisabled && styles.chipsOff]}>
        {SEND_CHIPS.map((chip) => (
          <Pressable
            key={chip.label}
            disabled={chipsDisabled}
            onPress={() => handleChip(chip.percent)}
            accessibilityRole="button"
            accessibilityLabel={chip.percent === 100 ? 'Send the full balance' : `Send ${chip.label} of the balance`}
            accessibilityState={{ disabled: chipsDisabled, selected: activeChip === chip.percent }}
            style={[styles.chip, activeChip === chip.percent && styles.chipOn]}
          >
            <Text style={[styles.chipLabel, activeChip === chip.percent && styles.chipLabelOn]}>{chip.label}</Text>
          </Pressable>
        ))}
      </View>

      {/* The slider's slot (#825 owns the slider): empty-state line only. */}
      <View style={styles.slot} accessibilityLabel="Send is not ready">
        <Text style={styles.slotSmall}>Swipe to send</Text>
        <Text style={styles.slotBig}>Enter an address and amount</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // The fixed 430px action body (design `.composer`: 10/12/12 padding, 8 gap);
  // an explicit height because the scroll content above it has no height to fill.
  body: { height: WALLET_ACTION_BODY_HEIGHT, paddingTop: 10, paddingBottom: 12, gap: 8 },
  // Design `.pcard`: the two cards share the free height.
  card: {
    flex: 1,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: tokens.colors.borderMuted,
    backgroundColor: tokens.colors.ground,
    padding: 12,
    justifyContent: 'space-between',
  },
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 28 },
  cap: {
    fontSize: 11,
    fontFamily: 'monospace',
    letterSpacing: 0.6,
    color: tokens.colors.textDim,
  },
  mid: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  // Design `.pick`: 40-tall pill with the token name.
  pill: {
    height: 40,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: tokens.colors.borderMuted,
    backgroundColor: tokens.colors.walletCore,
    justifyContent: 'center',
  },
  pillLabel: { fontSize: 15, fontWeight: '600', color: tokens.colors.bone },
  // Design `.amtn`: 34px mono, right aligned.
  amount: {
    flex: 1,
    minWidth: 0,
    padding: 0,
    textAlign: 'right',
    fontSize: 34,
    fontWeight: '600',
    fontFamily: 'monospace',
    letterSpacing: -1.5,
    color: tokens.colors.bone,
  },
  // Design `.addrf`: 15px mono.
  address: {
    padding: 0,
    fontSize: 15,
    fontFamily: 'monospace',
    color: tokens.colors.bone,
  },
  // Design `.mini`: 28-tall hairline button.
  mini: {
    height: 28,
    paddingHorizontal: 12,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: tokens.colors.borderMuted,
    justifyContent: 'center',
  },
  miniLabel: {
    fontSize: 11,
    fontWeight: '600',
    fontFamily: 'monospace',
    letterSpacing: 0.5,
    color: tokens.colors.bone,
  },
  // Design `.chips.eq`: four equal 32-tall chips, 8 gap.
  chips: { flexDirection: 'row', gap: 8, height: 32 },
  chipsOff: { opacity: 0.4 },
  chip: {
    flex: 1,
    height: 32,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: tokens.colors.borderMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipOn: { borderColor: tokens.colors.accent },
  chipLabel: { fontSize: 12, fontWeight: '600', color: tokens.colors.textDim },
  chipLabelOn: { color: tokens.colors.accent },
  // Design `.swipe`, resting state: 54 tall, radius 12. #825 puts the slider here.
  slot: {
    height: 54,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: tokens.colors.borderMuted,
    backgroundColor: tokens.colors.ground,
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  slotSmall: {
    fontSize: 10.5,
    fontFamily: 'monospace',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: tokens.colors.textDim,
  },
  slotBig: { fontSize: 14, fontWeight: '600', color: tokens.colors.bone },
  pressed: { opacity: 0.7 },
});
