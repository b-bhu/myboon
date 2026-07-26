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
import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import { useWallet } from '@/hooks/useWallet';
import { fetchPerpsAccount } from '@/features/perps/perps.public-api';
import { buildDepositInstruction } from '@/features/perps/perps.deposit-api';
import { SOLANA_RPC, USDC_MINT, USDC_LABEL, PACIFIC_MIN_DEPOSIT } from '@/features/perps/pacific.config';
import { semantic, tokens } from '@/theme';
import { fetchWithTimeout } from '@/lib/api';

function showAlert(title: string, msg: string) {
  if (Platform.OS === 'web') {
    window.alert(`${title}\n${msg}`);
  } else {
    Alert.alert(title, msg);
  }
}

interface DepositModalProps {
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

async function fetchTokenBalance(owner: string): Promise<number> {
  const res = await fetchWithTimeout(SOLANA_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getTokenAccountsByOwner',
      params: [
        owner,
        { mint: USDC_MINT },
        { encoding: 'jsonParsed' },
      ],
    }),
  });
  const json = await res.json();
  const accounts = json?.result?.value ?? [];
  if (accounts.length === 0) return 0;
  const amount = accounts[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmount;
  return typeof amount === 'number' ? amount : 0;
}

export function DepositModal({ visible, onClose, onRequestConnect }: DepositModalProps) {
  const { connected, address, signAndSendTransaction } = useWallet();
  const connection = new Connection(SOLANA_RPC);
  const [walletBalance, setWalletBalance] = useState<number | null>(null);
  const [pacificBalance, setPacificBalance] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [txSignature, setTxSignature] = useState<string | null>(null);
  const [amount, setAmount] = useState('');

  useEffect(() => {
    if (visible && connected && address) {
      setLoading(true);
      Promise.all([
        fetchTokenBalance(address),
        fetchPerpsAccount(address).catch(() => null),
      ])
        .then(([wallet, acc]) => {
          setWalletBalance(wallet);
          setPacificBalance(acc ? acc.equity : null);
        })
        .finally(() => setLoading(false));
    }
    if (!visible) {
      setAmount('');
      setTxSignature(null);
      setSubmitting(false);
    }
  }, [visible, connected, address]);

  function handleMax() {
    if (walletBalance !== null) {
      setAmount(walletBalance.toFixed(2));
    }
  }

  async function handleDeposit() {
    const depositAmount = parseFloat(amount);
    const sendTransaction = signAndSendTransaction as ((tx: Transaction) => Promise<string>) | null;
    if (!address || !depositAmount || depositAmount < PACIFIC_MIN_DEPOSIT) {
      showAlert('Invalid amount', `Minimum deposit is ${PACIFIC_MIN_DEPOSIT} ${USDC_LABEL}`);
      return;
    }
    if (!sendTransaction) {
      showAlert('Unsupported wallet', 'This wallet cannot send a Solana transaction from the app.');
      return;
    }
    if (walletBalance !== null && depositAmount > walletBalance) {
      showAlert('Insufficient balance', `You only have ${walletBalance.toFixed(2)} ${USDC_LABEL}`);
      return;
    }

    setSubmitting(true);
    setTxSignature(null);
    try {
      const depositor = new PublicKey(address);
      const ix = buildDepositInstruction(depositor, depositAmount);
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
      const tx = new Transaction({
        feePayer: depositor,
        blockhash,
        lastValidBlockHeight,
      }).add(ix);
      const sig = await sendTransaction(tx);
      setTxSignature(sig);

      // Refresh balances after deposit
      const [wallet, acc] = await Promise.all([
        fetchTokenBalance(address),
        fetchPerpsAccount(address).catch(() => null),
      ]);
      setWalletBalance(wallet);
      setPacificBalance(acc ? acc.equity : null);
      setAmount('');
    } catch (err: any) {
      const msg = err?.message ?? 'Deposit failed';
      showAlert('Deposit failed', msg);
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
            <Text style={styles.title}>Deposit</Text>
            <Pressable onPress={onClose} hitSlop={12}>
              <MaterialIcons name="close" size={18} color={semantic.text.dim} />
            </Pressable>
          </View>

          {!connected ? (
            <View style={styles.body}>
              <Text style={styles.infoText}>Connect your wallet to deposit</Text>
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
              <Text style={styles.infoText}>Loading balances...</Text>
            </View>
          ) : (
            <View style={styles.body}>
              {/* Balances */}
              <View style={styles.balanceCard}>
                <View style={styles.balanceRow}>
                  <Text style={styles.balanceLabel}>Wallet</Text>
                  <Text style={styles.balanceVal}>
                    {walletBalance !== null ? `${walletBalance.toFixed(2)} ${USDC_LABEL}` : '—'}
                  </Text>
                </View>
                <View style={styles.balanceDivider} />
                <View style={styles.balanceRow}>
                  <Text style={styles.balanceLabel}>Pacific Account</Text>
                  <Text style={styles.balanceVal}>
                    {pacificBalance !== null ? `$${pacificBalance.toFixed(2)}` : '—'}
                  </Text>
                </View>
              </View>

              {/* Amount input */}
              <View style={styles.inputSection}>
                <Text style={styles.inputLabel}>Amount to Deposit</Text>
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

              {/* Deposit button */}
              <Pressable
                style={({ pressed }) => [
                  styles.primaryBtn,
                  (!amount || parseFloat(amount) < PACIFIC_MIN_DEPOSIT || submitting) && styles.primaryBtnDisabled,
                  pressed && styles.primaryBtnPressed,
                ]}
                disabled={submitting}
                onPress={handleDeposit}>
                {submitting ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.primaryBtnText}>Deposit</Text>
                )}
              </Pressable>

              {txSignature && (
                <View style={styles.successRow}>
                  <MaterialIcons name="check-circle" size={14} color={tokens.colors.viridian} />
                  <Text style={styles.successText}>
                    Deposited! Tx: {txSignature.slice(0, 8)}...{txSignature.slice(-8)}
                  </Text>
                </View>
              )}

              <Text style={styles.footnote}>
                Deposits transfer {USDC_LABEL} from your wallet to your Pacific trading account.
                Minimum {PACIFIC_MIN_DEPOSIT} {USDC_LABEL}.
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

  // Balances
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

  // Input
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

  // Buttons
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
