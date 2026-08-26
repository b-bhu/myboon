import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SecureClient } from '@polymarket/client';
import {
  fetchBridgeSupportedAssets,
  fetchDepositStatus,
  fetchWithdrawalQuote,
  selectSupportedDepositAssets,
  SOLANA_CHAIN_ID,
  withdrawFromPolymarket,
} from '@/features/predict/predict.api';
import type { BridgeQuote, BridgeSupportedAsset, DepositBridgeStatus } from '@/features/predict/predict.api';
import { semantic, tokens } from '@/theme';

interface WithdrawModalProps {
  isOpen: boolean;
  onClose: () => void;
  client: SecureClient;
  /** Withdrawal destination on Solana — the bridge recipient, not a signer. */
  solanaAddress: string;
  cashBalance: number | null;
  onSuccess?: () => void;
}

type WithdrawState = 'input' | 'quoting' | 'confirming' | 'submitting' | 'success' | 'error';

interface TrackedWithdrawal {
  amount: number;
  recipientAddress: string;
  bridgeAddress: string;
  txHash: string | null;
  quote: BridgeQuote;
  status: DepositBridgeStatus | 'SUBMITTED';
  startedAt: number;
}

const WITHDRAW_POLL_MS = 10_000;
const WITHDRAW_TRACKING_PREFIX = 'predict.withdraw.tracking.v1';

export function WithdrawModal({
  isOpen,
  onClose,
  client,
  solanaAddress,
  cashBalance,
  onSuccess,
}: WithdrawModalProps) {
  const [amount, setAmount] = useState('');
  const [state, setState] = useState<WithdrawState>('input');
  const [txHash, setTxHash] = useState<string | null>(null);
  const [bridgeStatus, setBridgeStatus] = useState('Bridge processing');
  const [error, setError] = useState<string | null>(null);
  const [recipientAddress, setRecipientAddress] = useState(solanaAddress);
  const [destinationAsset, setDestinationAsset] = useState<BridgeSupportedAsset | null>(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const [quote, setQuote] = useState<BridgeQuote | null>(null);
  const [trackedWithdrawal, setTrackedWithdrawal] = useState<TrackedWithdrawal | null>(null);
  const trackingKey = `${WITHDRAW_TRACKING_PREFIX}:${client.account.wallet.toLowerCase()}`;

  const parsedAmount = parseFloat(amount);
  const minimumWithdraw = destinationAsset?.minCheckoutUsd ?? Number.POSITIVE_INFINITY;
  const trimmedRecipientAddress = recipientAddress.trim();
  const isRecipientValid = useMemo(() => {
    // Solana base58 addresses are usually 32-44 chars. Keep this client-side check light;
    // the bridge/server remains the source of truth.
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmedRecipientAddress);
  }, [trimmedRecipientAddress]);
  const isValid =
    parsedAmount >= minimumWithdraw &&
    (cashBalance === null || parsedAmount <= cashBalance) &&
    isRecipientValid;

  useEffect(() => {
    if (!isOpen) return;
    setRecipientAddress(solanaAddress);
    setRouteLoading(true);
    setError(null);
    Promise.all([
      fetchBridgeSupportedAssets(),
      AsyncStorage.getItem(trackingKey),
    ])
      .then(([assets, rawTracking]) => {
        const selected = selectSupportedDepositAssets(assets)
          .find((asset) => asset.chainId === SOLANA_CHAIN_ID) ?? null;
        setDestinationAsset(selected);
        if (!selected) setError('Solana USDC withdrawals are unavailable right now.');
        if (rawTracking) {
          const saved = JSON.parse(rawTracking) as TrackedWithdrawal;
          if (saved?.bridgeAddress && saved.quote) {
            setTrackedWithdrawal(saved);
            setAmount(String(saved.amount));
            setRecipientAddress(saved.recipientAddress);
            setQuote(saved.quote);
            setTxHash(saved.txHash);
            setBridgeStatus(saved.status === 'COMPLETED'
              ? 'Bridge completed'
              : saved.status === 'FAILED'
                ? 'Bridge reported a failure'
                : 'Bridge processing');
            setState('success');
          }
        }
      })
      .catch((loadError: unknown) => {
        setError(loadError instanceof Error ? loadError.message : 'Could not load the withdrawal route.');
      })
      .finally(() => setRouteLoading(false));
  }, [isOpen, solanaAddress, trackingKey]);

  const handleClose = () => {
    if (!trackedWithdrawal) {
      setAmount('');
      setState('input');
      setTxHash(null);
      setBridgeStatus('Bridge processing');
      setError(null);
      setQuote(null);
      setRecipientAddress(solanaAddress);
    }
    onClose();
  };

  const handleConfirm = async () => {
    if (!isValid) return;
    setState('quoting');
    setError(null);
    try {
      const reviewed = await fetchWithdrawalQuote(parsedAmount, trimmedRecipientAddress);
      setDestinationAsset(reviewed.asset);
      setQuote(reviewed.quote);
      setState('confirming');
    } catch (quoteError: unknown) {
      setError(quoteError instanceof Error ? quoteError.message : 'Could not quote this withdrawal.');
      setState('error');
    }
  };

  const handleSubmit = async () => {
    setState('submitting');
    setError(null);
    try {
      const result = await withdrawFromPolymarket(client, {
        amount: parsedAmount,
        solanaAddress: trimmedRecipientAddress,
      });
      if (result.ok) {
        if (!result.bridgeAddress || !result.quote) throw new Error('Bridge submission returned incomplete tracking details.');
        const tracking: TrackedWithdrawal = {
          amount: parsedAmount,
          recipientAddress: trimmedRecipientAddress,
          bridgeAddress: result.bridgeAddress,
          txHash: result.txHash ?? null,
          quote: result.quote,
          status: 'SUBMITTED',
          startedAt: Date.now(),
        };
        await AsyncStorage.setItem(trackingKey, JSON.stringify(tracking));
        setTrackedWithdrawal(tracking);
        setQuote(result.quote);
        setTxHash(result.txHash ?? null);
        setState('success');
        onSuccess?.();
      } else {
        setError(result.error ?? 'Withdraw failed');
        setState('error');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Withdraw failed');
      setState('error');
    }
  };

  useEffect(() => {
    if (!trackedWithdrawal?.bridgeAddress) return;
    if (trackedWithdrawal.status === 'COMPLETED' || trackedWithdrawal.status === 'FAILED') return;
    let cancelled = false;
    const refresh = async () => {
      const transactions = await fetchDepositStatus(trackedWithdrawal.bridgeAddress).catch(() => []);
      if (cancelled || transactions.length === 0) return;
      const latest = [...transactions].sort((a, b) => (b.createdTimeMs ?? 0) - (a.createdTimeMs ?? 0))[0];
      const nextStatus = latest?.status ?? 'PROCESSING';
      setBridgeStatus(nextStatus === 'COMPLETED'
        ? 'Bridge completed'
        : nextStatus === 'FAILED'
          ? 'Bridge reported a failure'
          : 'Bridge processing');
      setTrackedWithdrawal((current) => {
        if (!current) return current;
        const next = { ...current, status: nextStatus };
        AsyncStorage.setItem(trackingKey, JSON.stringify(next)).catch(() => {});
        return next;
      });
    };
    void refresh();
    const interval = setInterval(() => void refresh(), WITHDRAW_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [trackedWithdrawal?.bridgeAddress, trackedWithdrawal?.status, trackingKey]);

  const handleDismissTracking = async () => {
    await AsyncStorage.removeItem(trackingKey);
    setTrackedWithdrawal(null);
    setAmount('');
    setQuote(null);
    setTxHash(null);
    setBridgeStatus('Bridge processing');
    setState('input');
    onClose();
  };

  const handleMax = () => {
    if (cashBalance !== null && cashBalance > 0) {
      // Floor to 2 decimals to avoid exceeding balance
      setAmount((Math.floor(cashBalance * 100) / 100).toFixed(2));
    }
  };

  return (
    <Modal visible={isOpen} transparent animationType="slide" onRequestClose={handleClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.title}>Withdraw</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Close withdraw" onPress={handleClose} style={styles.closeBtn}>
              <MaterialIcons name="close" size={18} color={semantic.text.dim} />
            </Pressable>
          </View>

          {state === 'input' && (
            <>
              <Text style={styles.subtitle}>
                Withdraw USDC from Polymarket to a Solana wallet. Your connected wallet is prefilled, but you can change it.
              </Text>

              {/* Balance row */}
              <View style={styles.balanceRow}>
                <Text style={styles.balanceLabel}>Available</Text>
                <Text style={styles.balanceValue}>
                  {cashBalance !== null ? `$${cashBalance.toFixed(2)}` : '--'}
                </Text>
              </View>

              {routeLoading && (
                <View style={styles.routeRow}>
                  <ActivityIndicator size="small" color={tokens.colors.primary} />
                  <Text style={styles.statusSubtext}>Loading live Solana USDC route…</Text>
                </View>
              )}
              {error && !routeLoading && <Text style={styles.errorHint}>{error}</Text>}

              {/* Amount input */}
              <View style={styles.inputRow}>
                <Text style={styles.dollarSign}>$</Text>
                <TextInput
                  style={styles.amountInput}
                  value={amount}
                  onChangeText={setAmount}
                  placeholder="0.00"
                  placeholderTextColor={semantic.text.faint}
                  keyboardType="decimal-pad"
                  autoFocus
                />
                <Pressable onPress={handleMax} style={styles.maxBtn}>
                  <Text style={styles.maxText}>MAX</Text>
                </Pressable>
              </View>

              {/* Destination */}
              <View style={styles.destinationWrap}>
                <View style={styles.destRow}>
                  <MaterialIcons name="arrow-forward" size={10} color={semantic.text.faint} />
                  <Text style={styles.destLabel}>To Solana wallet</Text>
                  <Pressable onPress={() => setRecipientAddress(solanaAddress)}>
                    <Text style={styles.useConnectedText}>USE CONNECTED</Text>
                  </Pressable>
                </View>
                <TextInput
                  style={[styles.addressInput, recipientAddress.length > 0 && !isRecipientValid && styles.inputError]}
                  value={recipientAddress}
                  onChangeText={setRecipientAddress}
                  placeholder="Solana wallet address"
                  placeholderTextColor={semantic.text.faint}
                  autoCapitalize="none"
                  autoCorrect={false}
                  spellCheck={false}
                />
                {recipientAddress.length > 0 && !isRecipientValid && (
                  <Text style={styles.errorHint}>Enter a valid Solana wallet address.</Text>
                )}
              </View>

              <Pressable
                onPress={() => void handleConfirm()}
                disabled={!isValid || routeLoading}
                style={[styles.withdrawBtn, (!isValid || routeLoading) && styles.btnDisabled]}
              >
                <Text style={styles.withdrawBtnText}>Review Withdraw</Text>
              </Pressable>
            </>
          )}

          {state === 'quoting' && (
            <View style={styles.statusWrap}>
              <ActivityIndicator color={tokens.colors.primary} />
              <Text style={styles.statusText}>Checking the live Bridge quote…</Text>
              <Text style={styles.statusSubtext}>No transfer is sent until you review and confirm.</Text>
            </View>
          )}

          {state === 'confirming' && (
            <>
              <Text style={styles.subtitle}>Confirm your withdrawal</Text>

              <View style={styles.confirmCard}>
                <View style={styles.confirmRow}>
                  <Text style={styles.confirmLabel}>You send</Text>
                  <Text style={styles.confirmValue}>${parsedAmount.toFixed(2)} pUSD</Text>
                </View>
                <View style={styles.confirmRow}>
                  <Text style={styles.confirmLabel}>From</Text>
                  <Text style={styles.confirmValue}>Polymarket Deposit Wallet</Text>
                </View>
                <View style={styles.confirmRow}>
                  <Text style={styles.confirmLabel}>To</Text>
                  <Text style={styles.confirmValue}>
                    {trimmedRecipientAddress.slice(0, 8)}...{trimmedRecipientAddress.slice(-6)}
                  </Text>
                </View>
                <View style={styles.confirmRow}>
                  <Text style={styles.confirmLabel}>Estimated receive</Text>
                  <Text style={styles.confirmValue}>${quote?.estOutputUsd.toFixed(2) ?? '--'} USDC</Text>
                </View>
                <View style={styles.confirmRow}>
                  <Text style={styles.confirmLabel}>Fee / impact</Text>
                  <Text style={styles.confirmValue}>
                    {quote?.estFeeBreakdown.totalImpactUsd != null
                      ? `$${quote.estFeeBreakdown.totalImpactUsd.toFixed(2)} · ${quote.estFeeBreakdown.totalImpact?.toFixed(3) ?? '--'}%`
                      : '--'}
                  </Text>
                </View>
                <View style={styles.confirmRow}>
                  <Text style={styles.confirmLabel}>Minimum receive</Text>
                  <Text style={styles.confirmValue}>
                    {quote?.estFeeBreakdown.minReceived != null
                      ? `$${quote.estFeeBreakdown.minReceived.toFixed(2)} USDC`
                      : '--'}
                  </Text>
                </View>
                <View style={styles.confirmRow}>
                  <Text style={styles.confirmLabel}>Estimated time</Text>
                  <Text style={styles.confirmValue}>
                    {quote ? `${Math.max(1, Math.ceil(quote.estCheckoutTimeMs / 60_000))} min` : '--'}
                  </Text>
                </View>
              </View>

              <View style={styles.confirmActions}>
                <Pressable onPress={() => setState('input')} style={styles.backBtn}>
                  <Text style={styles.backBtnText}>Back</Text>
                </Pressable>
                <Pressable onPress={handleSubmit} style={[styles.withdrawBtn, { flex: 2 }]}>
                  <Text style={styles.withdrawBtnText}>Withdraw</Text>
                </Pressable>
              </View>
            </>
          )}

          {state === 'submitting' && (
            <View style={styles.statusWrap}>
              <ActivityIndicator color={tokens.colors.primary} />
              <Text style={styles.statusText}>Withdrawing ${parsedAmount.toFixed(2)} USDC...</Text>
              <Text style={styles.statusSubtext}>Relaying via builder (gasless)</Text>
            </View>
          )}

          {state === 'success' && (
            <View style={styles.statusWrap}>
              <MaterialIcons name="check-circle" size={32} color={tokens.colors.viridian} />
              <Text style={styles.statusText}>Withdraw submitted!</Text>
              <Text style={styles.statusSubtext}>
                ${parsedAmount.toFixed(2)} pUSD bridging to {trimmedRecipientAddress.slice(0, 8)}...{trimmedRecipientAddress.slice(-6)} as Solana USDC.{'\n'}
                {bridgeStatus}. It may take a few minutes to arrive.
              </Text>
              {txHash && (
                <Text style={styles.txHash}>tx: {txHash.slice(0, 10)}...{txHash.slice(-8)}</Text>
              )}
              <Pressable
                onPress={trackedWithdrawal?.status === 'COMPLETED' || trackedWithdrawal?.status === 'FAILED'
                  ? () => void handleDismissTracking()
                  : handleClose}
                style={[styles.withdrawBtn, { marginTop: 16, alignSelf: 'stretch' }]}
              >
                <Text style={styles.withdrawBtnText}>
                  {trackedWithdrawal?.status === 'COMPLETED' || trackedWithdrawal?.status === 'FAILED'
                    ? 'Done'
                    : 'Close · keep tracking'}
                </Text>
              </Pressable>
            </View>
          )}

          {state === 'error' && (
            <View style={styles.statusWrap}>
              <MaterialIcons name="error-outline" size={32} color={tokens.colors.vermillion} />
              <Text style={styles.statusText}>Withdraw failed</Text>
              <Text style={styles.statusSubtext}>{error}</Text>
              <Pressable onPress={() => setState('input')} style={[styles.withdrawBtn, { marginTop: 16, alignSelf: 'stretch' }]}>
                <Text style={styles.withdrawBtnText}>Try Again</Text>
              </Pressable>
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
    paddingHorizontal: tokens.spacing.lg,
    paddingTop: tokens.spacing.lg,
    paddingBottom: 40,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  title: {
    fontFamily: 'monospace',
    fontSize: 12,
    fontWeight: '700',
    color: semantic.text.primary,
    letterSpacing: 1,
  },
  closeBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: semantic.background.lift,
    alignItems: 'center',
    justifyContent: 'center',
  },
  subtitle: {
    fontFamily: 'monospace',
    fontSize: 9,
    color: semantic.text.primary,
    lineHeight: 14,
    marginBottom: 14,
    opacity: 0.7,
  },
  balanceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  balanceLabel: {
    fontFamily: 'monospace',
    fontSize: 8,
    color: semantic.text.dim,
    letterSpacing: 0.5,
  },
  balanceValue: {
    fontFamily: 'monospace',
    fontSize: 10,
    fontWeight: '700',
    color: semantic.text.primary,
  },
  routeRow: {
    minHeight: 30,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: semantic.background.lift,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 10,
    gap: 4,
  },
  dollarSign: {
    fontFamily: 'monospace',
    fontSize: 18,
    fontWeight: '700',
    color: semantic.text.dim,
  },
  amountInput: {
    flex: 1,
    fontFamily: 'monospace',
    fontSize: 18,
    fontWeight: '700',
    color: semantic.text.primary,
    padding: 0,
  },
  maxBtn: {
    backgroundColor: 'rgba(232,197,71,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(232,197,71,0.25)',
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  maxText: {
    fontFamily: 'monospace',
    fontSize: 7.5,
    fontWeight: '700',
    letterSpacing: 0.5,
    color: tokens.colors.primary,
  },
  destRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
  },
  destinationWrap: {
    marginBottom: 16,
  },
  destLabel: {
    fontFamily: 'monospace',
    fontSize: 8,
    color: semantic.text.dim,
    flex: 1,
  },
  useConnectedText: {
    fontFamily: 'monospace',
    fontSize: 7,
    fontWeight: '700',
    letterSpacing: 0.5,
    color: tokens.colors.primary,
  },
  addressInput: {
    fontFamily: 'monospace',
    fontSize: 9,
    color: semantic.text.primary,
    backgroundColor: semantic.background.lift,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 9,
  },
  inputError: {
    borderColor: tokens.colors.vermillion,
  },
  errorHint: {
    fontFamily: 'monospace',
    fontSize: 7.5,
    color: tokens.colors.vermillion,
    marginTop: 5,
  },
  withdrawBtn: {
    backgroundColor: tokens.colors.primary,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  withdrawBtnText: {
    fontFamily: 'monospace',
    fontSize: 10,
    fontWeight: '700',
    color: tokens.colors.backgroundDark,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  btnDisabled: { opacity: 0.4 },
  confirmCard: {
    backgroundColor: semantic.background.lift,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    borderRadius: 8,
    padding: 12,
    gap: 8,
    marginBottom: 16,
  },
  confirmRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  confirmLabel: {
    fontFamily: 'monospace',
    fontSize: 8,
    color: semantic.text.dim,
    letterSpacing: 0.5,
  },
  confirmValue: {
    fontFamily: 'monospace',
    fontSize: 9,
    fontWeight: '700',
    color: semantic.text.primary,
  },
  confirmActions: {
    flexDirection: 'row',
    gap: 8,
  },
  backBtn: {
    flex: 1,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  backBtnText: {
    fontFamily: 'monospace',
    fontSize: 10,
    fontWeight: '700',
    color: semantic.text.dim,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  statusWrap: {
    paddingVertical: 24,
    alignItems: 'center',
    gap: 8,
  },
  statusText: {
    fontFamily: 'monospace',
    fontSize: 11,
    fontWeight: '700',
    color: semantic.text.primary,
  },
  statusSubtext: {
    fontFamily: 'monospace',
    fontSize: 9,
    color: semantic.text.dim,
    textAlign: 'center',
    lineHeight: 14,
  },
  txHash: {
    fontFamily: 'monospace',
    fontSize: 8,
    color: semantic.text.faint,
    marginTop: 4,
  },
});
