import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  fetchWithdrawalTransferStatus,
  fetchWithdrawalQuote,
  preparePolymarketWithdrawal,
  selectSupportedDepositAssets,
  SOLANA_CHAIN_ID,
  submitPreparedWithdrawal,
} from '@/features/predict/predict.api';
import type { BridgeQuote, BridgeSupportedAsset } from '@/features/predict/predict.api';
import { normalizePredictError } from '@/features/predict/predict.errors';
import {
  createPreparedWithdrawal,
  isWithdrawalTerminal,
  markWithdrawalAmbiguous,
  markWithdrawalBridging,
  markWithdrawalFailed,
  markWithdrawalSubmitted,
  markWithdrawalSubmitting,
  reconcileWithdrawalTracking,
} from '@/features/predict/withdrawalTracking';
import type { TrackedWithdrawal } from '@/features/predict/withdrawalTracking';
import { createSingleFlightLock, runSingleFlight } from '@/features/predict/singleFlight';
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

const WITHDRAW_POLL_MS = 10_000;
const WITHDRAW_TRACKING_PREFIX = 'predict.withdraw.tracking.v1';

function isAmbiguousSubmissionError(code: string): boolean {
  return code === 'NETWORK_FAILED' || code === 'ORDER_WAITING' || code === 'PREDICT_FAILED';
}

function trackingMessage(tracking: TrackedWithdrawal): string {
  switch (tracking.status) {
    case 'PREPARED': return 'Ready for confirmation. No transfer has been submitted.';
    case 'SUBMITTING':
    case 'AMBIGUOUS':
      return 'Submission outcome is being reconciled. Do not retry this withdrawal.';
    case 'SUBMITTED': return 'Relayer accepted the transfer. Waiting for settlement.';
    case 'BRIDGING': return 'Relayer settled the transfer. Bridge delivery is in progress.';
    case 'COMPLETED': return 'Bridge completed the withdrawal.';
    case 'FAILED': return tracking.lastError ?? 'The withdrawal failed before Bridge delivery.';
  }
}

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
  const trackedWithdrawalRef = useRef<TrackedWithdrawal | null>(null);
  const submitLockRef = useRef(createSingleFlightLock());
  const refreshLockRef = useRef(createSingleFlightLock());
  const trackingKey = `${WITHDRAW_TRACKING_PREFIX}:${client.account.wallet.toLowerCase()}`;
  const persistTracking = useCallback(async (tracking: TrackedWithdrawal) => {
    await AsyncStorage.setItem(trackingKey, JSON.stringify(tracking));
    trackedWithdrawalRef.current = tracking;
    setTrackedWithdrawal(tracking);
  }, [trackingKey]);
  const persistAfterSubmission = useCallback(async (tracking: TrackedWithdrawal): Promise<boolean> => {
    // Once submission was attempted, never fall back to a clean retry screen
    // just because local persistence failed. Retain the state in memory and
    // continue reconciliation conservatively.
    trackedWithdrawalRef.current = tracking;
    setTrackedWithdrawal(tracking);
    try {
      await AsyncStorage.setItem(trackingKey, JSON.stringify(tracking));
      return true;
    } catch {
      return false;
    }
  }, [trackingKey]);

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
        if (!rawTracking) {
          trackedWithdrawalRef.current = null;
          setTrackedWithdrawal(null);
          setState('input');
          return;
        }
        if (rawTracking) {
          const parsed = JSON.parse(rawTracking) as TrackedWithdrawal & { txHash?: string | null };
          const legacyStatus = parsed.status as string;
          const saved: TrackedWithdrawal = {
            ...parsed,
            transactionId: parsed.transactionId ?? null,
            transactionHash: parsed.transactionHash ?? parsed.txHash ?? null,
            status: legacyStatus === 'DEPOSIT_DETECTED'
              || legacyStatus === 'PROCESSING'
              || legacyStatus === 'ORIGIN_TX_CONFIRMED'
              || legacyStatus === 'COMPLETED'
                ? legacyStatus === 'COMPLETED' ? 'COMPLETED' : 'BRIDGING'
                : legacyStatus === 'FAILED' ? 'FAILED' : parsed.status,
            updatedAt: parsed.updatedAt ?? parsed.startedAt,
            lastError: parsed.lastError ?? null,
          };
          if (saved?.bridgeAddress && saved.quote) {
            const restored = saved.status === 'SUBMITTING'
              ? markWithdrawalAmbiguous(saved, 'The app closed while submission was in progress.')
              : saved;
            trackedWithdrawalRef.current = restored;
            setTrackedWithdrawal(restored);
            if (restored !== saved) {
              AsyncStorage.setItem(trackingKey, JSON.stringify(restored)).catch(() => {});
            }
            setAmount(String(saved.amount));
            setRecipientAddress(saved.recipientAddress);
            setQuote(saved.quote);
            setTxHash(restored.transactionHash);
            setBridgeStatus(trackingMessage(restored));
            setState(restored.status === 'PREPARED' ? 'confirming' : 'success');
          } else {
            trackedWithdrawalRef.current = null;
            setTrackedWithdrawal(null);
            setState('input');
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

  const submitWithdrawal = async () => {
    setState('submitting');
    setError(null);
    try {
      const prepared = await preparePolymarketWithdrawal(client, {
        amount: parsedAmount,
        solanaAddress: trimmedRecipientAddress,
      });
      const preparedTracking = createPreparedWithdrawal({
        amount: prepared.amount,
        recipientAddress: prepared.solanaAddress,
        bridgeAddress: prepared.bridgeAddress,
        quote: prepared.quote,
      });
      // The reviewed intent and generated Bridge address are durable before any
      // transfer can be accepted upstream.
      await persistTracking(preparedTracking);
      setQuote(prepared.quote);

      const submitting = markWithdrawalSubmitting(preparedTracking);
      await persistTracking(submitting);

      let handle;
      try {
        handle = await submitPreparedWithdrawal(client, prepared);
      } catch (submitError: unknown) {
        const normalized = normalizePredictError(submitError, 'Withdrawal submission failed.');
        const next = isAmbiguousSubmissionError(normalized.code)
          ? markWithdrawalAmbiguous(submitting, normalized.message)
          : markWithdrawalFailed(submitting, normalized.message);
        const saved = await persistAfterSubmission(next);
        setBridgeStatus(saved
          ? trackingMessage(next)
          : 'Recovery storage is unavailable. Keep this app open and do not retry.');
        setState('success');
        return;
      }

      // Save the relayer identifiers before waiting. A timeout, app kill, or
      // transport failure after this point can be recovered on restart.
      const submitted = markWithdrawalSubmitted(
        submitting,
        handle.transactionId ? String(handle.transactionId) : null,
        handle.transactionHash ? String(handle.transactionHash) : null,
      );
      const submissionSaved = await persistAfterSubmission(submitted);
      setTxHash(submitted.transactionHash);
      setBridgeStatus(submissionSaved
        ? trackingMessage(submitted)
        : 'Relayer accepted the transfer, but recovery storage is unavailable. Do not retry.');
      setState('success');
      try { onSuccess?.(); } catch { /* submission remains accepted and tracked */ }

      try {
        const outcome = await handle.wait();
        const current = trackedWithdrawalRef.current?.bridgeAddress === submitted.bridgeAddress
          ? trackedWithdrawalRef.current
          : submitted;
        const bridging = markWithdrawalBridging(
          current,
          outcome.transactionId ? String(outcome.transactionId) : null,
          outcome.transactionHash ? String(outcome.transactionHash) : null,
        );
        const saved = await persistAfterSubmission(bridging);
        setTxHash(bridging.transactionHash);
        setBridgeStatus(saved
          ? trackingMessage(bridging)
          : 'Transfer settled, but recovery storage is unavailable. Keep this app open.');
      } catch (waitError: unknown) {
        const normalized = normalizePredictError(waitError, 'Withdrawal confirmation is unknown.');
        const current = trackedWithdrawalRef.current?.bridgeAddress === submitted.bridgeAddress
          ? trackedWithdrawalRef.current
          : submitted;
        const next = normalized.code === 'TRANSACTION_FAILED'
          ? markWithdrawalFailed(current, normalized.message)
          : markWithdrawalAmbiguous(current, normalized.message);
        const saved = await persistAfterSubmission(next);
        setBridgeStatus(saved
          ? trackingMessage(next)
          : 'Recovery storage is unavailable. Keep this app open and do not retry.');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Withdraw failed');
      setState('error');
    }
  };

  const handleSubmit = async () => {
    await runSingleFlight(submitLockRef.current, submitWithdrawal);
  };

  useEffect(() => {
    if (!trackedWithdrawal?.bridgeAddress) return;
    if (trackedWithdrawal.status === 'PREPARED' || isWithdrawalTerminal(trackedWithdrawal)) return;
    let cancelled = false;
    const refresh = () => runSingleFlight(refreshLockRef.current, async () => {
      const [bridgeResult, relayerResult] = await Promise.allSettled([
        fetchDepositStatus(trackedWithdrawal.bridgeAddress),
        trackedWithdrawal.transactionId
          ? fetchWithdrawalTransferStatus(client, trackedWithdrawal.transactionId)
          : Promise.resolve(null),
      ]);
      if (cancelled) return;
      const bridgeTransactions = bridgeResult.status === 'fulfilled' ? bridgeResult.value : [];
      const relayer = relayerResult.status === 'fulfilled' ? relayerResult.value : null;
      const current = trackedWithdrawalRef.current?.bridgeAddress === trackedWithdrawal.bridgeAddress
        ? trackedWithdrawalRef.current
        : trackedWithdrawal;
      const next = reconcileWithdrawalTracking(current, bridgeTransactions, relayer);
      setBridgeStatus(trackingMessage(next));
      setTxHash(next.transactionHash);
      if (next !== current) {
        trackedWithdrawalRef.current = next;
        setTrackedWithdrawal(next);
        await AsyncStorage.setItem(trackingKey, JSON.stringify(next)).catch(() => {});
      }
    });
    void refresh();
    const interval = setInterval(() => void refresh(), WITHDRAW_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [client, trackedWithdrawal, trackingKey]);

  const handleDismissTracking = async () => {
    await AsyncStorage.removeItem(trackingKey);
    trackedWithdrawalRef.current = null;
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
              <Text style={styles.statusSubtext}>
                Saving recovery details and reconciling the gasless transfer. Do not submit again.
              </Text>
            </View>
          )}

          {state === 'success' && (
            <View style={styles.statusWrap}>
              <MaterialIcons
                name={trackedWithdrawal?.status === 'FAILED'
                  ? 'error-outline'
                  : trackedWithdrawal?.status === 'COMPLETED'
                    ? 'check-circle'
                    : 'schedule'}
                size={32}
                color={trackedWithdrawal?.status === 'FAILED'
                  ? tokens.colors.vermillion
                  : trackedWithdrawal?.status === 'COMPLETED'
                    ? tokens.colors.viridian
                    : tokens.colors.primary}
              />
              <Text style={styles.statusText}>
                {trackedWithdrawal?.status === 'FAILED'
                  ? 'Withdrawal failed'
                  : trackedWithdrawal?.status === 'COMPLETED'
                    ? 'Withdrawal complete'
                    : 'Withdrawal tracking'}
              </Text>
              <Text style={styles.statusSubtext}>
                ${parsedAmount.toFixed(2)} pUSD bridging to {trimmedRecipientAddress.slice(0, 8)}...{trimmedRecipientAddress.slice(-6)} as Solana USDC.{'\n'}
                {bridgeStatus}
              </Text>
              {txHash && (
                <Text style={styles.txHash}>tx: {txHash.slice(0, 10)}...{txHash.slice(-8)}</Text>
              )}
              {trackedWithdrawal?.transactionId && (
                <Text style={styles.txHash}>relayer: {trackedWithdrawal.transactionId}</Text>
              )}
              <Pressable
                onPress={trackedWithdrawal && isWithdrawalTerminal(trackedWithdrawal)
                  ? () => void handleDismissTracking()
                  : handleClose}
                style={[styles.withdrawBtn, { marginTop: 16, alignSelf: 'stretch' }]}
              >
                <Text style={styles.withdrawBtnText}>
                  {trackedWithdrawal && isWithdrawalTerminal(trackedWithdrawal)
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
