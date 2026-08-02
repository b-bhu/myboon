import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { semantic, tokens } from '@/theme';
import { resolveApiBaseUrl, fetchWithTimeout } from '@/lib/api';
import { fetchClobBalance, fetchDepositStatus } from '@/features/predict/predict.api';
import type { DepositBridgeTransaction } from '@/features/predict/predict.api';

const API_BASE = resolveApiBaseUrl();

interface DepositModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** EOA/session address. Required for balance polling and auto-wrap. */
  polygonAddress: string;
  /** Trading/deposit wallet address used to create bridge deposit addresses. */
  depositWalletAddress: string;
  onFundsAvailable?: () => void | Promise<void>;
}

interface DepositAddresses {
  svm?: string;
  evm?: string;
  /**
   * The bridge returns additional chains beyond these two. They are typed as
   * possible but never rendered — see `SUPPORTED_CHAINS`.
   */
  [key: string]: string | undefined;
}

/**
 * The chains this app offers, in render order.
 *
 * An allowlist rather than a filter on the response: the bridge also returns
 * native-asset routes with different minimums and slower, less predictable
 * settlement, which widen the support surface for no benefit. Any chain the
 * bridge adds later is ignored until it is added here deliberately.
 *
 * This also fixes row order, which was previously whatever
 * `Object.entries()` happened to yield from the response.
 */
const SUPPORTED_CHAINS = ['evm', 'svm'] as const;

type SupportedChain = (typeof SUPPORTED_CHAINS)[number];

/**
 * Keyed by `SupportedChain` but indexable by any string: a *tracked* deposit
 * persisted before a chain was dropped can still reference one that is no
 * longer offered, and that lookup falls back rather than crashing.
 */
const CHAIN_META: Partial<Record<string, { label: string; color: string; note: string; min: string }>>
  & Record<SupportedChain, { label: string; color: string; note: string; min: string }> = {
  evm: { label: 'Ethereum / Polygon / Base', color: '#627eea', note: 'Send USDC from any EVM chain', min: 'Min: $1 USDC' },
  svm: { label: 'Solana', color: '#9945ff', note: 'Send USDC on Solana', min: 'Min: $1 USDC' },
};

function truncateAddress(addr: string): string {
  if (addr.length <= 16) return addr;
  return `${addr.slice(0, 10)}···${addr.slice(-8)}`;
}

type DepositStatusTone = 'waiting' | 'active' | 'success' | 'error';

interface TrackedDeposit {
  chain: string;
  address: string;
  baselineBalance: number | null;
  baselineKnown: boolean;
  baselineTransactionKeys: string[];
  hasStatusSnapshot: boolean;
  startedAt: number;
}

interface DepositStatusView {
  label: string;
  detail: string;
  tone: DepositStatusTone;
}

const DEPOSIT_POLL_MS = 10_000;
const DELAYED_AFTER_MS = 5 * 60_000;
const TRANSACTION_TIME_TOLERANCE_MS = 30_000;
const DEPOSIT_TRACKING_STORAGE_PREFIX = 'predict.deposit.tracking.v1';

function transactionKey(transaction: DepositBridgeTransaction): string {
  return [
    transaction.fromChainId ?? '',
    transaction.fromTokenAddress ?? '',
    transaction.fromAmountBaseUnit ?? '',
    transaction.toChainId ?? '',
    transaction.toTokenAddress ?? '',
    transaction.status ?? '',
    transaction.txHash ?? '',
    transaction.createdTimeMs ?? '',
  ].join(':');
}

function trackingTransactions(
  transactions: DepositBridgeTransaction[],
  trackedDeposit: TrackedDeposit,
): DepositBridgeTransaction[] {
  const baselineKeys = new Set(trackedDeposit.baselineTransactionKeys);
  return transactions.filter((transaction) => {
    if (baselineKeys.has(transactionKey(transaction))) return false;
    if (typeof transaction.createdTimeMs === 'number') {
      return transaction.createdTimeMs >= trackedDeposit.startedAt - TRANSACTION_TIME_TOLERANCE_MS;
    }
    return trackedDeposit.hasStatusSnapshot;
  });
}

function latestTransaction(transactions: DepositBridgeTransaction[]): DepositBridgeTransaction | null {
  if (transactions.length === 0) return null;
  return [...transactions].sort((a, b) => {
    const aTime = a.createdTimeMs ?? Number.MAX_SAFE_INTEGER;
    const bTime = b.createdTimeMs ?? Number.MAX_SAFE_INTEGER;
    return bTime - aTime;
  })[0] ?? null;
}

function statusFromTransaction(transaction: DepositBridgeTransaction | null, startedAt: number): DepositStatusView {
  if (!transaction?.status) {
    const delayed = Date.now() - startedAt > DELAYED_AFTER_MS;
    return delayed
      ? {
          label: 'Deposit delayed',
          detail: 'No bridge transaction detected yet. You can refresh or keep this open.',
          tone: 'error',
        }
      : {
          label: 'Waiting for deposit',
          detail: 'Send funds to the copied address. We will keep checking while this is open.',
          tone: 'waiting',
        };
  }

  switch (transaction.status) {
    case 'DEPOSIT_DETECTED':
      return {
        label: 'Deposit detected',
        detail: 'Funds were seen on the source chain and are waiting to process.',
        tone: 'active',
      };
    case 'PROCESSING':
    case 'ORIGIN_TX_CONFIRMED':
    case 'SUBMITTED':
      return {
        label: 'Wrapping / bridging funds',
        detail: 'The bridge is routing funds into your Polymarket wallet.',
        tone: 'active',
      };
    case 'COMPLETED':
      return {
        label: 'Finalizing funds',
        detail: 'Bridge completed. Checking your pUSD balance now.',
        tone: 'active',
      };
    case 'FAILED':
      return {
        label: 'Deposit delayed',
        detail: 'The bridge reported a failed transaction. Refresh or try another supported route.',
        tone: 'error',
      };
    default:
      return {
        label: 'Waiting for deposit',
        detail: 'We will keep checking while this is open.',
        tone: 'waiting',
      };
  }
}

export function DepositModal({
  isOpen,
  onClose,
  polygonAddress,
  depositWalletAddress,
  onFundsAvailable,
}: DepositModalProps) {
  const [addresses, setAddresses] = useState<DepositAddresses | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [trackedDeposit, setTrackedDeposit] = useState<TrackedDeposit | null>(null);
  const [statusView, setStatusView] = useState<DepositStatusView | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [trackingStorageKey, setTrackingStorageKey] = useState<string | null>(null);
  const fundsNotifiedRef = useRef(false);
  const storageKey = polygonAddress && depositWalletAddress
    ? `${DEPOSIT_TRACKING_STORAGE_PREFIX}:${polygonAddress.toLowerCase()}:${depositWalletAddress.toLowerCase()}`
    : null;

  useEffect(() => {
    if (!isOpen || !depositWalletAddress) return;

    setLoading(true);
    setError(null);

    fetchWithTimeout(`${API_BASE}/clob/deposit/${encodeURIComponent(depositWalletAddress)}`)
      .then((res) => {
        if (!res.ok) throw new Error('Failed to fetch deposit addresses');
        return res.json();
      })
      .then((data) => {
        const addrs = data.address ?? data;
        setAddresses(addrs);
      })
      .catch((err) => {
        setError(err.message);
      })
      .finally(() => setLoading(false));
  }, [isOpen, depositWalletAddress]);

  useEffect(() => {
    if (!isOpen) {
      setCopied(null);
      setStatusLoading(false);
    }
  }, [isOpen]);

  useEffect(() => {
    let cancelled = false;
    fundsNotifiedRef.current = false;
    setCopied(null);
    setStatusLoading(false);
    setTrackingStorageKey(null);
    setTrackedDeposit(null);
    setStatusView(null);

    if (!storageKey) {
      return () => {
        cancelled = true;
      };
    }

    AsyncStorage.getItem(storageKey)
      .then((raw) => {
        if (cancelled) return;
        if (!raw) {
          setTrackedDeposit(null);
          setStatusView(null);
          return;
        }

        const saved = JSON.parse(raw) as {
          trackedDeposit?: TrackedDeposit | null;
          statusView?: DepositStatusView | null;
        };
        setTrackedDeposit(saved.trackedDeposit ?? null);
        setStatusView(saved.statusView ?? null);
        setTrackingStorageKey(saved.trackedDeposit ? storageKey : null);
      })
      .catch(() => {
        if (!cancelled) {
          setTrackedDeposit(null);
          setStatusView(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [storageKey]);

  useEffect(() => {
    if (!storageKey || !trackedDeposit || trackingStorageKey !== storageKey) return;

    AsyncStorage.setItem(storageKey, JSON.stringify({ trackedDeposit, statusView })).catch(() => {});
  }, [statusView, storageKey, trackedDeposit, trackingStorageKey]);

  const refreshDepositStatus = useCallback(async () => {
    if (!trackedDeposit || !polygonAddress) return;
    if (!storageKey || trackingStorageKey !== storageKey) return;

    setStatusLoading(true);
    try {
      const [transactions, balance] = await Promise.all([
        fetchDepositStatus(trackedDeposit.address).catch(() => []),
        fetchClobBalance(polygonAddress).catch(() => null),
      ]);

      const baseline = trackedDeposit.baselineBalance ?? 0;
      const balanceReady = trackedDeposit.baselineKnown && balance
        ? balance.balance > baseline + 0.000001
        : false;

      if (balanceReady) {
        setStatusView({
          label: 'Funds available',
          detail: `Cash balance is now $${balance!.balance.toFixed(2)}.`,
          tone: 'success',
        });

        if (!fundsNotifiedRef.current) {
          fundsNotifiedRef.current = true;
          await onFundsAvailable?.();
        }
        return;
      }

      if (!trackedDeposit.baselineKnown && balance) {
        setTrackedDeposit((prev) => prev && prev.address === trackedDeposit.address
          ? { ...prev, baselineBalance: balance.balance, baselineKnown: true }
          : prev);
      }

      if (balance?.wrap?.error) {
        setStatusView({
          label: 'Deposit delayed',
          detail: 'Funds may have arrived, but wrapping needs another refresh.',
          tone: 'error',
        });
        return;
      }

      const bridgeView = statusFromTransaction(
        latestTransaction(trackingTransactions(transactions, trackedDeposit)),
        trackedDeposit.startedAt,
      );
      setStatusView(bridgeView);
    } finally {
      setStatusLoading(false);
    }
  }, [onFundsAvailable, polygonAddress, storageKey, trackedDeposit, trackingStorageKey]);

  useEffect(() => {
    if (!isOpen || !trackedDeposit) return;
    if (!storageKey || trackingStorageKey !== storageKey) return;

    void refreshDepositStatus();
    const interval = setInterval(() => {
      void refreshDepositStatus();
    }, DEPOSIT_POLL_MS);

    return () => clearInterval(interval);
  }, [isOpen, refreshDepositStatus, storageKey, trackedDeposit, trackingStorageKey]);

  const handleCopy = async (chain: string, address: string) => {
    await Clipboard.setStringAsync(address);
    setCopied(chain);
    const startedAt = Date.now();
    setStatusLoading(true);
    setStatusView({
      label: 'Waiting for deposit',
      detail: 'Checking current balance before tracking this deposit.',
      tone: 'waiting',
    });
    fundsNotifiedRef.current = false;

    const [baseline, existingTransactions] = await Promise.all([
      polygonAddress ? fetchClobBalance(polygonAddress).catch(() => null) : Promise.resolve(null),
      fetchDepositStatus(address).then(
        (transactions) => ({ transactions, ok: true }),
        () => ({ transactions: [] as DepositBridgeTransaction[], ok: false }),
      ),
    ]);

    setTrackedDeposit({
      chain,
      address,
      baselineBalance: baseline?.balance ?? null,
      baselineKnown: !!baseline,
      baselineTransactionKeys: existingTransactions.transactions.map(transactionKey),
      hasStatusSnapshot: existingTransactions.ok,
      startedAt,
    });
    setTrackingStorageKey(storageKey);
    setStatusView({
      label: 'Waiting for deposit',
      detail: 'Send funds to the copied address. We will keep checking while this is open.',
      tone: 'waiting',
    });
    setStatusLoading(false);
    setTimeout(() => setCopied(null), 2000);
  };

  const chains = SUPPORTED_CHAINS.flatMap((chain) => {
    const address = addresses?.[chain];
    return typeof address === 'string' && address.length > 0
      ? [[chain, address] as const]
      : [];
  });

  return (
    <Modal visible={isOpen} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.title}>Deposit</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Close deposit" onPress={onClose} style={styles.closeBtn}>
              <MaterialIcons name="close" size={18} color={semantic.text.dim} />
            </Pressable>
          </View>

          <Text style={styles.subtitle}>
            Send funds to any address below.{'\n'}Auto-bridges to your Polymarket account.
          </Text>

          {/* Content */}
          {loading && (
            <View style={styles.loadingWrap}>
              <ActivityIndicator color={tokens.colors.primary} />
              <Text style={styles.loadingText}>Fetching deposit addresses...</Text>
            </View>
          )}

          {error && (
            <View style={styles.errorWrap}>
              <MaterialIcons name="error-outline" size={16} color={tokens.colors.vermillion} />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}

          {!loading && !error && chains.length > 0 && (
            <View style={styles.list}>
              {chains.map(([chain, address]) => {
                // Total, because `chain` comes from `SUPPORTED_CHAINS` — the
                // previous unknown-chain fallback is unreachable now.
                const meta = CHAIN_META[chain];
                const isCopied = copied === chain;

                return (
                  <Pressable
                    key={chain}
                    onPress={() => handleCopy(chain, address)}
                    style={styles.chainCard}
                  >
                    <View style={styles.chainHeader}>
                      <View style={[styles.chainDot, { backgroundColor: meta.color }]} />
                      <Text style={styles.chainLabel}>{meta.label}</Text>
                      <View style={[styles.copyChip, isCopied && styles.copyChipActive]}>
                        <MaterialIcons
                          name={isCopied ? 'check' : 'content-copy'}
                          size={10}
                          color={isCopied ? '#fff' : tokens.colors.primary}
                        />
                        <Text style={[styles.copyText, isCopied && styles.copiedText]}>
                          {isCopied ? 'Copied!' : 'Tap to copy'}
                        </Text>
                      </View>
                    </View>
                    <Text style={styles.addressText} numberOfLines={1} ellipsizeMode="middle">
                      {address}
                    </Text>
                    <View style={styles.noteRow}>
                      <Text style={styles.noteText}>{meta.note}</Text>
                      {meta.min ? <Text style={styles.minText}>{meta.min}</Text> : null}
                    </View>
                  </Pressable>
                );
              })}
            </View>
          )}

          {/*
            The request succeeded but carried no chain this app supports.
            Without this the sheet renders a blank gap between the subtitle
            and the footer, which reads as a broken screen rather than a
            temporary upstream state.
          */}
          {!loading && !error && chains.length === 0 && (
            <View style={styles.errorWrap}>
              <MaterialIcons name="info-outline" size={16} color={semantic.text.dim} />
              <Text style={styles.errorText}>
                No deposit address is available right now. Try again in a moment.
              </Text>
            </View>
          )}

          {trackedDeposit && statusView && (
            <View
              style={[
                styles.statusCard,
                statusView.tone === 'success'
                  ? styles.statusCard_success
                  : statusView.tone === 'error'
                    ? styles.statusCard_error
                    : statusView.tone === 'active'
                      ? styles.statusCard_active
                      : styles.statusCard_waiting,
              ]}
            >
              <View style={styles.statusHeader}>
                <View
                  style={[
                    styles.statusDot,
                    statusView.tone === 'success'
                      ? styles.statusDot_success
                      : statusView.tone === 'error'
                        ? styles.statusDot_error
                        : statusView.tone === 'active'
                          ? styles.statusDot_active
                          : styles.statusDot_waiting,
                  ]}
                />
                <View style={styles.statusTextWrap}>
                  <Text style={styles.statusLabel}>{statusView.label}</Text>
                  <Text style={styles.statusDetail}>{statusView.detail}</Text>
                </View>
                {statusLoading ? (
                  <ActivityIndicator size="small" color={tokens.colors.primary} />
                ) : (
                  <Pressable onPress={() => void refreshDepositStatus()} style={styles.refreshBtn}>
                    <MaterialIcons name="refresh" size={14} color={semantic.text.dim} />
                  </Pressable>
                )}
              </View>
              <Text style={styles.trackedText}>
                Tracking {CHAIN_META[trackedDeposit.chain]?.label ?? trackedDeposit.chain.toUpperCase()} {truncateAddress(trackedDeposit.address)}
              </Text>
              {statusView.tone === 'success' && (
                <Pressable onPress={onClose} style={styles.doneBtn}>
                  <Text style={styles.doneText}>Done</Text>
                </Pressable>
              )}
            </View>
          )}

          {!loading && !error && chains.length === 0 && addresses && (
            <Text style={styles.emptyText}>No deposit addresses available.</Text>
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
    maxHeight: '80%',
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
  loadingWrap: {
    paddingVertical: 30,
    alignItems: 'center',
    gap: 8,
  },
  loadingText: {
    fontFamily: 'monospace',
    fontSize: 9,
    color: semantic.text.dim,
  },
  errorWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 16,
  },
  errorText: {
    fontFamily: 'monospace',
    fontSize: 9,
    color: tokens.colors.vermillion,
  },
  list: {
    gap: 6,
  },
  chainCard: {
    backgroundColor: semantic.background.lift,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    borderRadius: 8,
    padding: 11,
    marginBottom: 6,
    gap: 4,
  },
  chainHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  chainDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  chainLabel: {
    flex: 1,
    fontFamily: 'monospace',
    fontSize: 10,
    fontWeight: '700',
    color: semantic.text.primary,
  },
  copyChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: 'rgba(232,197,71,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(232,197,71,0.25)',
    borderRadius: 4,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  copyChipActive: {
    backgroundColor: tokens.colors.viridian,
    borderColor: tokens.colors.viridian,
  },
  copyText: {
    fontFamily: 'monospace',
    fontSize: 7.5,
    fontWeight: '700',
    letterSpacing: 0.5,
    color: tokens.colors.primary,
  },
  copiedText: {
    color: '#fff',
  },
  addressText: {
    fontFamily: 'monospace',
    fontSize: 9,
    color: semantic.text.accent,
    letterSpacing: 0.3,
  },
  noteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  noteText: {
    fontFamily: 'monospace',
    fontSize: 7.5,
    color: semantic.text.dim,
  },
  minText: {
    fontFamily: 'monospace',
    fontSize: 7,
    fontWeight: '700',
    color: tokens.colors.primary,
    letterSpacing: 0.3,
  },
  emptyText: {
    fontFamily: 'monospace',
    fontSize: 9,
    color: semantic.text.dim,
    textAlign: 'center',
    paddingVertical: 20,
  },
  statusCard: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 11,
    marginTop: 8,
    gap: 8,
  },
  statusCard_waiting: {
    backgroundColor: semantic.background.lift,
    borderColor: semantic.border.muted,
  },
  statusCard_active: {
    backgroundColor: 'rgba(232,197,71,0.10)',
    borderColor: 'rgba(232,197,71,0.25)',
  },
  statusCard_success: {
    backgroundColor: 'rgba(45,145,110,0.12)',
    borderColor: 'rgba(45,145,110,0.35)',
  },
  statusCard_error: {
    backgroundColor: 'rgba(214,77,64,0.12)',
    borderColor: 'rgba(214,77,64,0.35)',
  },
  statusHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  statusDot_waiting: {
    backgroundColor: semantic.text.dim,
  },
  statusDot_active: {
    backgroundColor: tokens.colors.primary,
  },
  statusDot_success: {
    backgroundColor: tokens.colors.viridian,
  },
  statusDot_error: {
    backgroundColor: tokens.colors.vermillion,
  },
  statusTextWrap: {
    flex: 1,
    gap: 2,
  },
  statusLabel: {
    fontFamily: 'monospace',
    fontSize: 10,
    fontWeight: '700',
    color: semantic.text.primary,
  },
  statusDetail: {
    fontFamily: 'monospace',
    fontSize: 8,
    lineHeight: 12,
    color: semantic.text.dim,
  },
  refreshBtn: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: semantic.background.surface,
  },
  trackedText: {
    fontFamily: 'monospace',
    fontSize: 7.5,
    color: semantic.text.faint,
  },
  doneBtn: {
    alignSelf: 'flex-start',
    backgroundColor: tokens.colors.viridian,
    borderRadius: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  doneText: {
    fontFamily: 'monospace',
    fontSize: 8,
    fontWeight: '700',
    color: '#fff',
    letterSpacing: 0.5,
  },
});
