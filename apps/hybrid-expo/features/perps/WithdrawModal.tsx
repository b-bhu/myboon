import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useWallet } from '@/hooks/useWallet';
import { fetchPerpsAccount } from '@/features/perps/perps.public-api';
import { requestWithdrawal } from '@/features/perps/perps.signed-api';
import { USDC_LABEL } from '@/features/perps/pacific.config';
import { semantic, tokens } from '@/theme';

function showAlert(title: string, msg: string) {
  if (Platform.OS === 'web') {
    window.alert(`${title}\n${msg}`);
  } else {
    Alert.alert(title, msg);
  }
}

const MIN_WITHDRAWAL = 1; // Pacific minimum: $1
const WITHDRAWAL_FEE = 1; // Pacific charges $1 per withdrawal

interface WithdrawModalProps {
  visible: boolean;
  onClose: () => void;
  /**
   * Ask the parent screen to open the shared connection sheet.
   *
   * The sheet is *not* rendered inside this modal: a Modal nested in another
   * Modal is unreliable on iOS. Instead this closes itself and hands the request
   * up, so the sheet mounts at the screen level. Omitted callers fall back to
   * the modal's own connect-less message rather than a dead button.
   */
  onRequestConnect?: () => void;
}

export function WithdrawModal({ visible, onClose, onRequestConnect }: WithdrawModalProps) {
  const { connected, address, signMessage } = useWallet();
  const [available, setAvailable] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [amount, setAmount] = useState('');

  useEffect(() => {
    if (visible && connected && address) {
      setLoading(true);
      fetchPerpsAccount(address)
        .then((acc) => setAvailable(acc.availableToWithdraw))
        .catch(() => setAvailable(null))
        .finally(() => setLoading(false));
    }
    if (!visible) {
      setAmount('');
      setSuccess(false);
      setSubmitting(false);
    }
  }, [visible, connected, address]);

  function handleMax() {
    if (available !== null) {
      setAmount(available.toFixed(2));
    }
  }

  async function handleWithdraw() {
    const withdrawAmount = parseFloat(amount);
    if (!address || !withdrawAmount || withdrawAmount < MIN_WITHDRAWAL) {
      showAlert('Invalid amount', `Minimum withdrawal is $${MIN_WITHDRAWAL}`);
      return;
    }
    if (available !== null && withdrawAmount > available) {
      showAlert('Insufficient balance', `Available: $${available.toFixed(2)}`);
      return;
    }

    setSubmitting(true);
    setSuccess(false);
    try {
      await requestWithdrawal(withdrawAmount, address, signMessage);
      setSuccess(true);
      setAmount('');

      // Refresh balance
      const acc = await fetchPerpsAccount(address).catch(() => null);
      if (acc) setAvailable(acc.availableToWithdraw);
    } catch (err: any) {
      const msg = err?.message ?? 'Withdrawal failed';
      showAlert('Withdrawal failed', msg);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.title}>Withdraw</Text>
            <Pressable onPress={onClose} hitSlop={12}>
              <MaterialIcons name="close" size={18} color={semantic.text.dim} />
            </Pressable>
          </View>

          {!connected ? (
            <View style={styles.body}>
              <Text style={styles.infoText}>Connect your wallet to withdraw</Text>
              {onRequestConnect ? (
                <Pressable
                  style={styles.primaryBtn}
                  onPress={() => {
                    // Close first, then hand up: the sheet mounts at screen
                    // level, so this modal must be out of the way.
                    onClose();
                    onRequestConnect();
                  }}
                >
                  <Text style={styles.primaryBtnText}>Connect wallet</Text>
                </Pressable>
              ) : null}
            </View>
          ) : loading ? (
            <View style={styles.body}>
              <ActivityIndicator size="small" color={semantic.text.accent} />
              <Text style={styles.infoText}>Loading balance...</Text>
            </View>
          ) : (
            <View style={styles.body}>
              {/* Balance card */}
              <View style={styles.balanceCard}>
                <View style={styles.balanceRow}>
                  <Text style={styles.balanceLabel}>Available to Withdraw</Text>
                  <Text style={styles.balanceVal}>
                    {available !== null ? `$${available.toFixed(2)}` : '—'}
                  </Text>
                </View>
                <View style={styles.balanceDivider} />
                <View style={styles.balanceRow}>
                  <Text style={styles.balanceLabel}>Withdrawal Fee</Text>
                  <Text style={styles.balanceVal}>${WITHDRAWAL_FEE}</Text>
                </View>
              </View>

              {/* Amount input */}
              <View style={styles.inputSection}>
                <Text style={styles.inputLabel}>Amount to Withdraw</Text>
                <View style={styles.inputRow}>
                  <TextInput
                    style={styles.input}
                    value={amount}
                    onChangeText={setAmount}
                    placeholder="0.00"
                    placeholderTextColor={semantic.text.faint}
                    keyboardType="decimal-pad"
                    selectTextOnFocus
                  />
                  <Pressable style={styles.maxBtn} onPress={handleMax}>
                    <Text style={styles.maxBtnText}>MAX</Text>
                  </Pressable>
                  <Text style={styles.inputUnit}>{USDC_LABEL}</Text>
                </View>
              </View>

              {/* Net receive preview */}
              {amount !== '' && parseFloat(amount) > 0 && (
                <View style={styles.netRow}>
                  <Text style={styles.netLabel}>You receive</Text>
                  <Text style={styles.netVal}>
                    ~{Math.max(0, parseFloat(amount) - WITHDRAWAL_FEE).toFixed(2)} {USDC_LABEL}
                  </Text>
                </View>
              )}

              {/* Withdraw button */}
              <Pressable
                style={({ pressed }) => [
                  styles.primaryBtn,
                  (!amount || parseFloat(amount) < MIN_WITHDRAWAL || submitting) && styles.primaryBtnDisabled,
                  pressed && styles.primaryBtnPressed,
                ]}
                disabled={submitting}
                onPress={handleWithdraw}>
                {submitting ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.primaryBtnText}>Withdraw</Text>
                )}
              </Pressable>

              {success && (
                <View style={styles.successRow}>
                  <MaterialIcons name="check-circle" size={14} color={tokens.colors.viridian} />
                  <Text style={styles.successText}>
                    {'Withdrawal requested! ' + USDC_LABEL + ' will arrive in your wallet shortly.'}
                  </Text>
                </View>
              )}

              <Text style={styles.footnote}>
                {'Withdrawals send ' + USDC_LABEL + ' from your Pacific account to your wallet. $' + WITHDRAWAL_FEE + ' fee per withdrawal. Minimum $' + MIN_WITHDRAWAL + '.'}
              </Text>
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.72)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: semantic.background.surface,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderTopWidth: 1,
    borderColor: semantic.border.muted,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: tokens.spacing.lg,
    paddingVertical: tokens.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: semantic.border.muted,
  },
  title: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.md,
    fontWeight: '700',
    color: semantic.text.primary,
    letterSpacing: 1,
  },
  body: {
    padding: tokens.spacing.lg,
    gap: tokens.spacing.md,
    paddingBottom: 40,
    alignItems: 'stretch',
  },
  balanceCard: {
    backgroundColor: semantic.background.lift,
    borderRadius: tokens.radius.md,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    padding: tokens.spacing.md,
    gap: 0,
  },
  balanceRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: tokens.spacing.sm,
  },
  balanceDivider: {
    height: 1,
    backgroundColor: semantic.border.muted,
  },
  balanceLabel: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xs,
    color: semantic.text.dim,
    letterSpacing: 0.5,
  },
  balanceVal: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.sm,
    fontWeight: '600',
    color: semantic.text.primary,
  },
  inputSection: {
    gap: tokens.spacing.xs,
  },
  inputLabel: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    color: semantic.text.dim,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: semantic.background.lift,
    borderRadius: tokens.radius.md,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    paddingHorizontal: tokens.spacing.md,
    gap: tokens.spacing.sm,
  },
  input: {
    flex: 1,
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.lg,
    fontWeight: '700',
    color: semantic.text.primary,
    paddingVertical: tokens.spacing.md,
  },
  maxBtn: {
    backgroundColor: 'rgba(199,183,112,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(199,183,112,0.20)',
    borderRadius: tokens.radius.xs,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  maxBtnText: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs,
    fontWeight: '700',
    letterSpacing: 1.5,
    color: tokens.colors.primary,
  },
  inputUnit: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xs,
    color: semantic.text.dim,
    letterSpacing: 0.8,
  },
  netRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: 'rgba(199,183,112,0.06)',
    borderRadius: tokens.radius.sm,
    borderWidth: 1,
    borderColor: 'rgba(199,183,112,0.14)',
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
  },
  netLabel: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs,
    color: semantic.text.dim,
    letterSpacing: 0.8,
  },
  netVal: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.sm,
    fontWeight: '700',
    color: tokens.colors.primary,
  },
  primaryBtn: {
    backgroundColor: tokens.colors.viridian,
    borderRadius: tokens.radius.md,
    paddingVertical: tokens.spacing.md + 2,
    alignItems: 'center',
  },
  primaryBtnDisabled: {
    opacity: 0.4,
  },
  primaryBtnPressed: {
    opacity: 0.8,
  },
  primaryBtnText: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.sm,
    fontWeight: '700',
    color: '#fff',
    letterSpacing: 1,
  },
  infoText: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xs,
    color: semantic.text.dim,
    textAlign: 'center',
    paddingVertical: tokens.spacing.md,
  },
  successRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: tokens.spacing.xs,
    paddingVertical: tokens.spacing.sm,
    backgroundColor: 'rgba(74,140,111,0.08)',
    borderRadius: tokens.radius.sm,
    borderWidth: 1,
    borderColor: 'rgba(74,140,111,0.20)',
  },
  successText: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs,
    color: tokens.colors.viridian,
    letterSpacing: 0.5,
  },
  footnote: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs,
    color: semantic.text.faint,
    textAlign: 'center',
    lineHeight: 16,
  },
});
