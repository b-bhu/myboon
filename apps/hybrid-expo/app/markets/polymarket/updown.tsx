import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle } from 'react-native-svg';
import {
  AppTopBar,
  AppTopBarCashPill,
  AppTopBarIconButton,
  AppTopBarLogo,
  AppTopBarTitle,
} from '@/components/AppTopBar';
import { CashOutConfirmModal } from '@/features/predict/components/CashOutConfirmModal';
import { CycleChart, type CyclePoint } from '@/features/predict/components/CycleChart';
import { OrderComposerSheet, type ComposerMode } from '@/features/predict/components/OrderComposerSheet';
import { truncateUsd } from '@/features/predict/formatPredictMoney';
import { buildExecutableBuyQuote, getBestAsk } from '@/features/predict/orderbookQuote';
import { makePendingOpenOrder } from '@/features/predict/pendingOpenOrders';
import { usePositionSellQuotes } from '@/features/predict/positionSellQuotes';
import {
  fetchClobBalance,
  fetchLivePrices,
  fetchMarketPositions,
  fetchOrderbook,
  fetchUpDownHistory,
  fetchUpDownRounds,
  placeBet,
  type PortfolioPosition,
  type UpDownHistory,
  type UpDownRound,
} from '@/features/predict/predict.api';
import type { Orderbook } from '@/features/predict/predict.types';
import { usePredictQuickAmounts } from '@/features/predict/usePredictQuickAmounts';
import { ConnectionSheet } from '@/features/wallet/components/ConnectionSheet';
import { useConnectionSheet } from '@/features/wallet/components/useConnectionSheet';
import { useFocusedAppStateInterval } from '@/hooks/useFocusedAppStateInterval';
import { usePolymarketWallet } from '@/hooks/usePolymarketWallet';
import { semantic, tokens } from '@/theme';

type Asset = 'btc' | 'eth';
type Duration = 'hourly' | 'daily';
type Surface = 'chart' | 'book';
type PickSide = 'up' | 'down';
type Phase = 'open' | 'settling' | 'unavailable';

interface BooksState {
  up: Orderbook | null;
  down: Orderbook | null;
}

const EMPTY_BOOKS: BooksState = { up: null, down: null };

function formatCountdown(endMs: number, nowMs: number): string | null {
  const remaining = endMs - nowMs;
  if (!Number.isFinite(remaining) || remaining <= 0) return null;
  const totalSeconds = Math.floor(remaining / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes.toString().padStart(2, '0')}m`;
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

function getRoundPhase(round: UpDownRound | null, now: number): Phase {
  if (!round) return 'unavailable';
  if (round.closed || (round.endDate !== null && Date.parse(round.endDate) <= now)) return 'settling';
  return 'open';
}

function formatAssetPrice(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '--';
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatProbability(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '--' : `${Math.round(value * 100)}¢`;
}

function formatSignedUsd(value: number): string {
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function positionSide(position: PortfolioPosition): PickSide {
  return /down|lower|no/iu.test(position.outcome) ? 'down' : 'up';
}

function assetName(asset: Asset): string {
  return asset === 'btc' ? 'Bitcoin' : 'Ethereum';
}

function RoundTimerDial({
  duration,
  countdown,
  phase,
  roundStart,
  roundEnd,
  now,
  onPress,
}: {
  duration: Duration;
  countdown: string | null;
  phase: Phase;
  roundStart: number;
  roundEnd: number;
  now: number;
  onPress: () => void;
}) {
  const radius = 39;
  const circumference = 2 * Math.PI * radius;
  const elapsed = Math.min(1, Math.max(0, (now - roundStart) / Math.max(roundEnd - roundStart, 1)));

  return (
    <Pressable
      style={styles.durationDial}
      accessibilityRole="button"
      accessibilityLabel="Change round duration"
      onPress={onPress}
    >
      <Svg width={96} height={96} style={StyleSheet.absoluteFill}>
        <Circle cx={48} cy={48} r={radius} fill="none" stroke={tokens.colors.borderMuted} strokeWidth={7} />
        <Circle
          cx={48}
          cy={48}
          r={radius}
          fill="none"
          stroke={tokens.colors.accent}
          strokeWidth={7}
          strokeLinecap="round"
          strokeDasharray={`${circumference} ${circumference}`}
          strokeDashoffset={circumference * (1 - elapsed)}
          transform="rotate(-90 48 48)"
        />
      </Svg>
      <Text style={styles.durationValue}>{duration === 'hourly' ? '1 HOUR' : '1 DAY'}</Text>
      <Text style={[styles.dialCountdown, phase !== 'open' && styles.dialCountdownClosed]}>
        {phase === 'open' ? countdown ?? 'LIVE' : 'CLOSED'}
      </Text>
      <Text style={styles.dialHint}>TAP TO CHANGE</Text>
    </Pressable>
  );
}

function CompactBook({ books, loading }: { books: BooksState; loading: boolean }) {
  const columns = [
    { key: 'up' as const, label: 'Higher', color: semantic.sentiment.positive, book: books.up },
    { key: 'down' as const, label: 'Lower', color: semantic.sentiment.negative, book: books.down },
  ];

  return (
    <View style={styles.bookWrap}>
      {columns.map((column) => {
        const asks = [...(column.book?.asks ?? [])]
          .filter((level) => Number(level.price) > 0 && Number(level.size) > 0)
          .sort((a, b) => Number(a.price) - Number(b.price))
          .slice(0, 4);
        return (
          <View key={column.key} style={styles.bookColumn}>
            <View style={styles.bookTitleRow}>
              <View style={[styles.bookDot, { backgroundColor: column.color }]} />
              <Text style={styles.bookTitle}>{column.label}</Text>
            </View>
            <View style={styles.bookHeaderRow}>
              <Text style={styles.bookHeader}>Price</Text>
              <Text style={styles.bookHeader}>Available</Text>
            </View>
            {asks.length > 0 ? asks.map((level, index) => {
              const price = Number(level.price);
              const available = price * Number(level.size);
              return (
                <View key={`${level.price}:${index}`} style={styles.bookLevelRow}>
                  <Text style={[styles.bookPrice, { color: column.color }]}>{Math.round(price * 100)}¢</Text>
                  <Text style={styles.bookAvailable}>${available.toFixed(0)}</Text>
                </View>
              );
            }) : (
              <Text style={styles.bookEmpty}>{loading ? 'Loading...' : 'No live asks'}</Text>
            )}
          </View>
        );
      })}
    </View>
  );
}

export default function PredictUpDownScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width: viewportWidth } = useWindowDimensions();
  const poly = usePolymarketWallet();
  const connectSheet = useConnectionSheet('evm');
  const { quickAmounts } = usePredictQuickAmounts();

  const [asset, setAsset] = useState<Asset>('btc');
  const [duration, setDuration] = useState<Duration>('hourly');
  const [surface, setSurface] = useState<Surface>('chart');
  const [selectedSide, setSelectedSide] = useState<PickSide>('up');
  const [rounds, setRounds] = useState<Awaited<ReturnType<typeof fetchUpDownRounds>> | null>(null);
  const [history, setHistory] = useState<UpDownHistory | null>(null);
  const [books, setBooks] = useState<BooksState>(EMPTY_BOOKS);
  const [livePrices, setLivePrices] = useState<Record<string, number | null>>({});
  const [positions, setPositions] = useState<PortfolioPosition[]>([]);
  const [cashBalance, setCashBalance] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [bookLoading, setBookLoading] = useState(false);
  const [positionsLoading, setPositionsLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const [composerOpen, setComposerOpen] = useState(false);
  const [pendingComposerSide, setPendingComposerSide] = useState<PickSide | null>(null);
  const [amount, setAmount] = useState('5');
  const [submitting, setSubmitting] = useState(false);
  const [setupSubmitting, setSetupSubmitting] = useState(false);
  const [durationPickerOpen, setDurationPickerOpen] = useState(false);
  const [positionFace, setPositionFace] = useState(false);
  const [cashOutPosition, setCashOutPosition] = useState<PortfolioPosition | null>(null);
  const submitInFlightRef = useRef(false);
  const snapshotInFlightRef = useRef(false);

  const round = rounds?.[asset]?.[duration] ?? null;
  const phase = getRoundPhase(round, now);
  const upTokenId = round?.clobTokenIds[0] ?? null;
  const downTokenId = round?.clobTokenIds[1] ?? null;
  const roundKey = `${asset}:${duration}:${round?.slug ?? ''}`;

  const loadRounds = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    if (!silent) setLoading(true);
    try {
      const next = await fetchUpDownRounds();
      setRounds(next);
      setErrorMessage(null);
    } catch (error) {
      if (!silent) {
        setErrorMessage(error instanceof Error ? error.message : 'Unable to load rounds');
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const next = await fetchUpDownHistory(asset, duration);
      setHistory(next);
    } catch {
      setHistory(null);
    } finally {
      setHistoryLoading(false);
    }
  }, [asset, duration]);

  const loadBooksAndPrices = useCallback(async () => {
    if (!upTokenId || !downTokenId) {
      setBooks(EMPTY_BOOKS);
      setLivePrices({});
      return;
    }
    setBookLoading(true);
    const [upResult, downResult, priceResult] = await Promise.allSettled([
      fetchOrderbook(upTokenId),
      fetchOrderbook(downTokenId),
      fetchLivePrices([upTokenId, downTokenId]),
    ]);
    setBooks({
      up: upResult.status === 'fulfilled' ? upResult.value : null,
      down: downResult.status === 'fulfilled' ? downResult.value : null,
    });
    if (priceResult.status === 'fulfilled') setLivePrices(priceResult.value);
    setBookLoading(false);
  }, [downTokenId, upTokenId]);

  const loadWalletData = useCallback(async () => {
    const gammaAddress = poly.tradingAddress ?? poly.polygonAddress;
    if (!poly.polygonAddress || !gammaAddress || !round?.slug) {
      setCashBalance(null);
      setPositions([]);
      return;
    }
    setPositionsLoading(true);
    const [balanceResult, positionResult] = await Promise.allSettled([
      fetchClobBalance(poly.polygonAddress),
      fetchMarketPositions(gammaAddress, round.slug),
    ]);
    if (balanceResult.status === 'fulfilled') setCashBalance(balanceResult.value?.balance ?? null);
    if (positionResult.status === 'fulfilled') {
      setPositions(positionResult.value.filter((position) => position.size > 0.0001));
    }
    setPositionsLoading(false);
  }, [poly.polygonAddress, poly.tradingAddress, round?.slug]);

  const refreshSnapshot = useCallback(async () => {
    if (snapshotInFlightRef.current) return;
    snapshotInFlightRef.current = true;
    try {
      await Promise.allSettled([
        loadRounds({ silent: true }),
        loadHistory(),
        loadBooksAndPrices(),
        loadWalletData(),
      ]);
    } finally {
      snapshotInFlightRef.current = false;
    }
  }, [loadBooksAndPrices, loadHistory, loadRounds, loadWalletData]);

  useEffect(() => { void loadRounds(); }, [loadRounds]);
  useEffect(() => { void loadHistory(); }, [loadHistory, round?.slug]);
  useEffect(() => { void loadBooksAndPrices(); }, [loadBooksAndPrices]);
  useEffect(() => { void loadWalletData(); }, [loadWalletData]);

  useEffect(() => {
    setHistory(null);
    setBooks(EMPTY_BOOKS);
    setPositionFace(false);
    setComposerOpen(false);
  }, [roundKey]);

  useEffect(() => {
    const timer = globalThis.setInterval(() => setNow(Date.now()), 1_000);
    return () => globalThis.clearInterval(timer);
  }, []);

  useFocusedAppStateInterval(async (isCurrent) => {
    await refreshSnapshot();
    if (!isCurrent()) return;
    setNow(Date.now());
  }, 10_000, { resetKey: roundKey });

  useEffect(() => {
    if (!pendingComposerSide || !poly.isReady) return;
    setSelectedSide(pendingComposerSide);
    setAmount(String(quickAmounts[0] ?? 5));
    setPendingComposerSide(null);
    setComposerOpen(true);
  }, [pendingComposerSide, poly.isReady, quickAmounts]);

  const { booksByAsset: sellBooks } = usePositionSellQuotes(positions);
  const activePosition = useMemo(
    () => [...positions].sort((a, b) => b.currentValue - a.currentValue)[0] ?? null,
    [positions],
  );

  const upPrice = upTokenId
    ? getBestAsk(books.up) ?? livePrices[upTokenId] ?? round?.upPrice ?? null
    : null;
  const downPrice = downTokenId
    ? getBestAsk(books.down) ?? livePrices[downTokenId] ?? round?.downPrice ?? null
    : null;
  const selectedBook = selectedSide === 'up' ? books.up : books.down;
  const selectedPrice = selectedSide === 'up' ? upPrice : downPrice;
  const executableQuote = buildExecutableBuyQuote(selectedBook, Number.parseFloat(amount) || 0);

  const fallbackRoundSpan = duration === 'daily' ? 86_400_000 : 3_600_000;
  const parsedRoundStart = Date.parse(history?.startDate || round?.startDate || '');
  const roundStart = Number.isFinite(parsedRoundStart) ? parsedRoundStart : now - fallbackRoundSpan;
  const parsedRoundEnd = Date.parse(history?.endDate || round?.endDate || '');
  const roundEnd = Number.isFinite(parsedRoundEnd) && parsedRoundEnd > roundStart
    ? parsedRoundEnd
    : roundStart + fallbackRoundSpan;
  const targetPrice = history?.priceToBeat ?? round?.priceToBeat ?? null;
  const currentAssetPrice = history?.currentPrice ?? round?.currentPrice ?? null;
  const chartPoints = useMemo(() => {
    const points = (history?.points ?? [])
      .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.p))
      .sort((a, b) => a.t - b.t);
    if (currentAssetPrice !== null) {
      const last = points[points.length - 1];
      if (!last || Math.abs(last.p - currentAssetPrice) > 0.000001 || now - last.t > 5_000) {
        points.push({ t: Math.min(now, roundEnd), p: currentAssetPrice });
      }
    }
    return points;
  }, [currentAssetPrice, history?.points, now, roundEnd]);
  const previousPoints: CyclePoint[] = chartPoints.filter(
    (point) => point.t < roundStart && point.t >= roundStart - 30 * 60 * 1_000,
  );
  const currentPoints: CyclePoint[] = chartPoints.filter(
    (point) => point.t >= roundStart && point.t <= roundEnd,
  );
  const direction = currentAssetPrice !== null && targetPrice !== null
    ? currentAssetPrice >= targetPrice ? 'up' as const : 'down' as const
    : null;
  const delta = currentAssetPrice !== null && targetPrice !== null ? currentAssetPrice - targetPrice : null;
  const countdown = round?.endDate ? formatCountdown(Date.parse(round.endDate), now) : null;
  const chartWidth = Math.max(260, Math.min(viewportWidth - 34, 560));
  const ctaPayout = executableQuote.executable && executableQuote.shares > 0
    ? executableQuote.shares
    : null;

  async function requestComposer(side: PickSide) {
    if (phase !== 'open' || submitting || setupSubmitting) return;
    setSelectedSide(side);
    setAmount(String(quickAmounts[0] ?? 5));
    if (!poly.signer) {
      setPendingComposerSide(side);
      connectSheet.open('evm');
      return;
    }
    if (!poly.isReady) {
      setPendingComposerSide(side);
      setSetupSubmitting(true);
      try {
        await poly.enable();
      } catch (error) {
        setPendingComposerSide(null);
        Alert.alert('Predict setup failed', error instanceof Error ? error.message : 'Try again in a moment.');
      } finally {
        setSetupSubmitting(false);
      }
      return;
    }
    setComposerOpen(true);
  }

  async function submitRoundOrder(params: { mode: ComposerMode; limitPriceCents: number }) {
    if (!round || !poly.signer || !poly.polygonAddress || submitting || submitInFlightRef.current) return;
    const spend = Number.parseFloat(amount);
    const tokenId = selectedSide === 'down' ? downTokenId : upTokenId;
    if (!tokenId || !Number.isFinite(spend) || spend <= 0) return;

    submitInFlightRef.current = true;
    setSubmitting(true);
    try {
      if (!poly.canSignLocally) await poly.enable();
      if (!poly.polygonAddress || !poly.signer) throw new Error('Wallet session not ready');

      const freshBook = await fetchOrderbook(tokenId).catch(() => null);
      const quote = buildExecutableBuyQuote(freshBook, spend);
      const isLimit = params.mode === 'limit';
      let price: number;
      let size: number;
      if (isLimit) {
        price = params.limitPriceCents / 100;
        size = spend / price;
      } else {
        if (!quote.executable || quote.limitPrice === null || quote.shares <= 0) {
          Alert.alert('Not filled', 'Price or liquidity changed. Try a smaller amount or refresh the round.');
          return;
        }
        price = quote.limitPrice;
        size = quote.shares;
      }

      const expiration = Math.floor(Date.parse(round.endDate ?? '') / 1_000);
      if (isLimit && (!Number.isFinite(expiration) || expiration <= Math.floor(Date.now() / 1_000))) {
        throw new Error('This round is no longer accepting limit orders.');
      }

      const result = await placeBet(poly.signer, {
        polygonAddress: poly.polygonAddress,
        tradingAddress: poly.tradingAddress,
        tokenID: tokenId,
        price,
        size,
        amount: spend,
        side: 'BUY',
        negRisk: false,
        orderType: isLimit ? 'GTD' : 'FOK',
        ...(isLimit ? { expiration } : {}),
      });
      if (!result.success) throw new Error(result.error || 'Order failed');

      makePendingOpenOrder({
        id: result.orderID ?? result.operationId,
        slug: round.slug,
        tokenID: tokenId,
        price,
        size,
        outcome: selectedSide === 'up' ? 'Higher' : 'Lower',
      });
      setComposerOpen(false);
      await loadWalletData();
    } catch (error) {
      Alert.alert('Order failed', error instanceof Error ? error.message : 'Try again in a moment.');
    } finally {
      submitInFlightRef.current = false;
      setSubmitting(false);
    }
  }

  async function confirmCashOut(size: number, limitPrice: number) {
    const position = cashOutPosition;
    if (!position || !poly.signer || !poly.polygonAddress || submitting || submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    setSubmitting(true);
    try {
      if (!poly.canSignLocally) await poly.enable();
      const result = await placeBet(poly.signer, {
        polygonAddress: poly.polygonAddress,
        tradingAddress: poly.tradingAddress,
        tokenID: position.asset,
        price: limitPrice,
        size,
        side: 'SELL',
        negRisk: position.negativeRisk,
        orderType: 'FOK',
      });
      if (!result.success) throw new Error(result.error || 'Cash out failed');
      setCashOutPosition(null);
      await loadWalletData();
    } catch (error) {
      Alert.alert('Cash out failed', error instanceof Error ? error.message : 'Try again in a moment.');
    } finally {
      submitInFlightRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <AppTopBar
        left={<AppTopBarLogo />}
        center={<AppTopBarTitle tone="primary">Predict</AppTopBarTitle>}
        right={(
          <View style={styles.topActions}>
            <AppTopBarCashPill value={truncateUsd(cashBalance)} />
            <AppTopBarIconButton
              icon="person-outline"
              accessibilityLabel="Open Predict profile"
              onPress={() => router.push('/markets/polymarket/profile')}
            />
          </View>
        )}
      />

      <ScrollView
        style={styles.scroller}
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator
        refreshControl={(
          <RefreshControl
            refreshing={refreshing}
            tintColor={tokens.colors.primary}
            onRefresh={async () => {
              setRefreshing(true);
              await refreshSnapshot();
              setRefreshing(false);
            }}
          />
        )}
        contentContainerStyle={[styles.content, { paddingBottom: Math.max(insets.bottom, 18) + 24 }]}
      >
        {loading ? (
          <View style={styles.stateCard}>
            <ActivityIndicator color={tokens.colors.primary} />
            <Text style={styles.stateCopy}>Loading live rounds...</Text>
          </View>
        ) : errorMessage && !rounds ? (
          <View style={styles.stateCard}>
            <Text style={styles.stateTitle}>Rounds unavailable</Text>
            <Text style={styles.stateCopy}>{errorMessage}</Text>
            <Pressable style={styles.retryButton} onPress={() => void loadRounds()} accessibilityRole="button">
              <Text style={styles.retryText}>Try again</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.deck}>
            <View style={styles.assetRow} accessibilityRole="tablist">
              {(['btc', 'eth'] as const).map((entry) => (
                <Pressable
                  key={entry}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: asset === entry }}
                  style={[styles.assetTab, asset === entry && styles.assetTabActive]}
                  onPress={() => setAsset(entry)}
                >
                  <Text style={[styles.assetTabText, asset === entry && styles.assetTabTextActive]}>
                    {entry.toUpperCase()}
                  </Text>
                  {asset === entry ? <View style={styles.assetIndicator} /> : null}
                </Pressable>
              ))}
              {activePosition ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={positionFace ? 'Show round' : 'Show your position'}
                  style={[styles.positionToggle, positionFace && styles.positionToggleActive]}
                  onPress={() => setPositionFace((current) => !current)}
                >
                  <MaterialIcons name={positionFace ? 'show-chart' : 'account-balance-wallet'} size={18} color={semantic.text.primary} />
                </Pressable>
              ) : positionsLoading ? <ActivityIndicator size="small" color={semantic.text.faint} /> : null}
            </View>

            {positionFace && activePosition ? (
              <View style={styles.positionFace}>
                <Text style={styles.cardEyebrow}>Your live position</Text>
                <Text style={styles.positionOutcome}>{positionSide(activePosition) === 'up' ? 'Higher' : 'Lower'}</Text>
                <Text style={styles.positionQuestion} numberOfLines={2}>{activePosition.title || round?.question}</Text>
                <View style={styles.pnlHero}>
                  <Text style={styles.pnlLabel}>Live P/L</Text>
                  <Text style={[
                    styles.pnlValue,
                    activePosition.cashPnl > 0 ? styles.positive : activePosition.cashPnl < 0 ? styles.negative : null,
                  ]}>
                    {formatSignedUsd(activePosition.cashPnl)}
                  </Text>
                </View>
                <View style={styles.positionGrid}>
                  <View style={styles.positionStat}><Text style={styles.statLabel}>Entry</Text><Text style={styles.statValue}>{formatProbability(activePosition.avgPrice)}</Text></View>
                  <View style={styles.positionStat}><Text style={styles.statLabel}>Current</Text><Text style={styles.statValue}>{formatProbability(activePosition.curPrice)}</Text></View>
                  <View style={styles.positionStat}><Text style={styles.statLabel}>Shares</Text><Text style={styles.statValue}>{activePosition.size.toFixed(2)}</Text></View>
                  <View style={styles.positionStat}><Text style={styles.statLabel}>Value</Text><Text style={styles.statValue}>{truncateUsd(activePosition.currentValue)}</Text></View>
                </View>
                <View style={styles.positionActions}>
                  <Pressable
                    style={styles.secondaryButton}
                    accessibilityRole="button"
                    onPress={() => void requestComposer(positionSide(activePosition))}
                  >
                    <Text style={styles.secondaryButtonText}>Add to pick</Text>
                  </Pressable>
                  <Pressable
                    style={styles.primaryButton}
                    accessibilityRole="button"
                    onPress={() => setCashOutPosition(activePosition)}
                  >
                    <Text style={styles.primaryButtonText}>Cash out</Text>
                  </Pressable>
                </View>
              </View>
            ) : !round ? (
              <View style={styles.stateCardInner}>
                <Text style={styles.stateTitle}>No round available</Text>
                <Text style={styles.stateCopy}>The next {asset.toUpperCase()} round will appear here when Polymarket publishes it.</Text>
              </View>
            ) : (
              <>
                <View style={styles.heroSection}>
                  <View style={styles.questionCopy}>
                    <Text style={styles.marketEyebrow}>{assetName(asset)} fast market</Text>
                    <Text style={styles.heroTitle}>WILL {asset.toUpperCase()}</Text>
                    <Text style={styles.heroTitleItalic}>FINISH HIGHER?</Text>
                    <Text style={styles.targetRule}>
                      {targetPrice === null
                        ? 'Target price is temporarily unavailable.'
                        : duration === 'hourly' ? 'Finish at or above ' : 'Finish above '}
                      {targetPrice !== null ? <Text style={styles.targetPriceText}>{formatAssetPrice(targetPrice)}</Text> : null}
                      {targetPrice !== null ? ' when the clock hits zero.' : null}
                    </Text>
                  </View>
                  <RoundTimerDial
                    duration={duration}
                    countdown={countdown}
                    phase={phase}
                    roundStart={roundStart}
                    roundEnd={roundEnd}
                    now={now}
                    onPress={() => setDurationPickerOpen(true)}
                  />
                </View>

                {phase === 'settling' ? (
                  <View style={styles.settlingBanner}>
                    <ActivityIndicator size="small" color={semantic.text.dim} />
                    <View style={styles.settlingCopy}>
                      <Text style={styles.settlingTitle}>Round closed</Text>
                      <Text style={styles.settlingText}>Waiting for Polymarket to settle the result.</Text>
                    </View>
                  </View>
                ) : null}

                <View style={styles.marketStage}>
                  <View style={styles.marketHeader}>
                    <View>
                      <Text style={styles.priceLabel}>Right now</Text>
                      <Text style={styles.assetPrice}>{formatAssetPrice(currentAssetPrice)}</Text>
                    </View>
                    <View style={styles.surfaceTabs} accessibilityRole="tablist">
                      {(['chart', 'book'] as const).map((entry) => {
                        const selected = surface === entry;
                        return (
                          <Pressable
                            key={entry}
                            accessibilityRole="tab"
                            accessibilityState={{ selected }}
                            style={[styles.surfaceTab, selected && styles.surfaceTabActive]}
                            onPress={() => setSurface(entry)}
                          >
                            <MaterialIcons
                              name={entry === 'chart' ? 'show-chart' : 'layers'}
                              size={14}
                              color={selected ? tokens.colors.backgroundDark : semantic.text.faint}
                            />
                            <Text style={[styles.surfaceText, selected && styles.surfaceTextActive]}>
                              {entry === 'chart' ? 'Chart' : 'Book'}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  </View>

                  <View style={styles.marketSurface}>
                    {surface === 'chart' ? (
                      targetPrice !== null && (currentPoints.length > 0 || previousPoints.length > 0) ? (
                        <CycleChart
                          previous={previousPoints}
                          current={currentPoints}
                          targetPrice={targetPrice}
                          roundStart={roundStart}
                          roundEnd={roundEnd}
                          width={chartWidth}
                          height={236}
                          direction={direction}
                          formatPrice={(value) => formatAssetPrice(value)}
                        />
                      ) : (
                        <View style={styles.surfaceState}>
                          {historyLoading ? <ActivityIndicator color={semantic.text.faint} /> : null}
                          <Text style={styles.stateCopy}>{historyLoading ? 'Loading price history...' : 'Price history is temporarily unavailable.'}</Text>
                        </View>
                      )
                    ) : <CompactBook books={books} loading={bookLoading} />}
                    {surface === 'chart' ? (
                      <View style={styles.verdictOverlay} pointerEvents="none">
                      <Text style={[
                        styles.verdictWord,
                        delta !== null && delta >= 0 ? styles.positive : styles.negative,
                      ]}>
                        {delta === null ? 'WAITING' : delta >= 0 ? 'ABOVE' : 'BELOW'}
                      </Text>
                        <Text style={styles.verdictContext}>
                          {delta === null ? 'Target comparison unavailable' : `${formatSignedUsd(delta)} from target`}
                        </Text>
                      </View>
                    ) : null}
                  </View>
                </View>

                <View style={styles.pickRow}>
                  {([
                    { side: 'up' as const, label: 'Higher', price: upPrice },
                    { side: 'down' as const, label: 'Lower', price: downPrice },
                  ]).map((entry) => {
                    const selected = selectedSide === entry.side;
                    const positiveSide = entry.side === 'up';
                    return (
                      <Pressable
                        key={entry.side}
                        accessibilityRole="radio"
                        accessibilityState={{ selected, disabled: phase !== 'open' }}
                        style={[
                          styles.pickButton,
                          positiveSide ? styles.pickHigher : styles.pickLower,
                          selected && (positiveSide ? styles.pickHigherSelected : styles.pickLowerSelected),
                          phase !== 'open' && styles.disabled,
                        ]}
                        disabled={phase !== 'open'}
                        onPress={() => setSelectedSide(entry.side)}
                      >
                        <View style={styles.pickCopy}>
                          <Text style={[styles.pickLabel, selected && styles.pickTextSelected]}>{entry.label}</Text>
                          <Text style={[styles.pickHelper, selected && styles.pickHelperSelected]}>
                            {positiveSide
                              ? duration === 'hourly' ? 'wins at or above target' : 'wins above target'
                              : duration === 'hourly' ? 'wins below target' : 'wins at or below target'}
                          </Text>
                        </View>
                        <Text style={[
                          styles.pickPrice,
                          positiveSide ? styles.higherPrice : styles.lowerPrice,
                          selected && styles.pickTextSelected,
                        ]}>
                          {formatProbability(entry.price)}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>

                <View style={styles.actionSection}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ disabled: phase !== 'open' || setupSubmitting, busy: setupSubmitting }}
                    style={[
                      styles.makePickButton,
                      selectedSide === 'up' ? styles.makePickHigher : styles.makePickLower,
                      (phase !== 'open' || setupSubmitting) && styles.disabled,
                    ]}
                    disabled={phase !== 'open' || setupSubmitting}
                    onPress={() => void requestComposer(selectedSide)}
                  >
                    <Text style={styles.makePickText}>
                      {setupSubmitting ? 'Setting up Predict...' : `Back ${selectedSide === 'up' ? 'Higher' : 'Lower'} for $${amount}`}
                    </Text>
                    <Text style={styles.makePickReturn}>
                      {ctaPayout === null ? 'Review live quote' : `Get ${truncateUsd(ctaPayout)} if right`}
                    </Text>
                  </Pressable>
                </View>
              </>
            )}
          </View>
        )}
      </ScrollView>

      <Modal transparent visible={durationPickerOpen} animationType="fade" onRequestClose={() => setDurationPickerOpen(false)}>
        <View style={styles.modalBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setDurationPickerOpen(false)} accessibilityLabel="Close duration picker" />
          <View style={[styles.bottomSheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
            <View style={styles.sheetGrabber} />
            <Text style={styles.sheetEyebrow}>How fast?</Text>
            <Text style={styles.sheetTitle}>Choose a round</Text>
            {([
              { value: 'hourly' as const, title: '1 hour', copy: 'One episode. A faster call.' },
              { value: 'daily' as const, title: '1 day', copy: 'Sleep on it. More time to move.' },
            ]).map((entry) => (
              <Pressable
                key={entry.value}
                style={[styles.durationOption, duration === entry.value && styles.durationOptionActive]}
                onPress={() => { setDuration(entry.value); setDurationPickerOpen(false); }}
              >
                <View style={styles.durationOptionCopy}>
                  <Text style={styles.durationOptionTitle}>{entry.title}</Text>
                  <Text style={styles.durationOptionText}>{entry.copy}</Text>
                </View>
                {duration === entry.value ? <MaterialIcons name="check-circle" size={22} color={tokens.colors.viridian} /> : null}
              </Pressable>
            ))}
          </View>
        </View>
      </Modal>

      <OrderComposerSheet
        visible={composerOpen && round !== null}
        side={selectedSide === 'up' ? 'yes' : 'no'}
        pickLabel={selectedSide === 'up' ? 'Higher' : 'Lower'}
        question={round?.question ?? null}
        currentPrice={selectedPrice}
        amount={amount}
        onAmountChange={setAmount}
        executableAvgPrice={executableQuote.executable ? executableQuote.averagePrice : null}
        availableCash={cashBalance}
        quickAmounts={quickAmounts}
        limitOrderNote="Rests until it matches. Any unmatched amount cancels at this round's deadline."
        submitting={submitting}
        disabled={!poly.isReady || phase !== 'open'}
        onClose={() => setComposerOpen(false)}
        onConfirm={(params) => void submitRoundOrder(params)}
      />

      <CashOutConfirmModal
        visible={cashOutPosition !== null}
        position={cashOutPosition}
        submitting={submitting}
        orderbook={cashOutPosition?.asset ? sellBooks[cashOutPosition.asset]?.book ?? null : null}
        quoteLoading={cashOutPosition?.asset ? sellBooks[cashOutPosition.asset]?.loading ?? false : false}
        quoteError={cashOutPosition?.asset ? sellBooks[cashOutPosition.asset]?.error ?? null : null}
        onClose={() => setCashOutPosition(null)}
        onConfirm={(size, limitPrice) => void confirmCashOut(size, limitPrice)}
      />

      <ConnectionSheet visible={connectSheet.visible} chain={connectSheet.chain} onClose={() => connectSheet.close()} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: semantic.background.screen },
  scroller: { flex: 1 },
  topActions: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  content: { paddingHorizontal: 16, paddingTop: 2 },
  deck: { borderRadius: 28, borderCurve: 'continuous', overflow: 'hidden', backgroundColor: tokens.colors.ground, borderWidth: 1, borderColor: semantic.border.muted, boxShadow: '0 14px 28px rgba(3,31,44,0.34)' },
  assetRow: { minHeight: 60, flexDirection: 'row', alignItems: 'stretch', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: semantic.border.muted, backgroundColor: tokens.colors.surface },
  assetTab: { flex: 1, minHeight: 60, alignItems: 'center', justifyContent: 'center' },
  assetTabActive: { backgroundColor: 'transparent' },
  assetTabText: { fontFamily: 'monospace', fontSize: 11, fontWeight: '800', color: semantic.text.faint },
  assetTabTextActive: { color: semantic.text.primary },
  assetIndicator: { position: 'absolute', bottom: 0, width: '66%', height: 5, borderTopLeftRadius: 4, borderTopRightRadius: 4, backgroundColor: tokens.colors.accent },
  positionToggle: { width: 48, margin: 6, borderRadius: 14, borderCurve: 'continuous', alignItems: 'center', justifyContent: 'center', backgroundColor: tokens.colors.lift },
  positionToggleActive: { backgroundColor: tokens.colors.accent },
  heroSection: { minHeight: 188, position: 'relative', justifyContent: 'center', paddingHorizontal: 20, paddingVertical: 18 },
  questionCopy: { paddingRight: 96 },
  marketEyebrow: { fontFamily: 'monospace', fontSize: 9, lineHeight: 13, fontWeight: '800', letterSpacing: 1.4, textTransform: 'uppercase', color: semantic.text.dim },
  heroTitle: { paddingTop: 7, fontSize: 29, lineHeight: 31, letterSpacing: -1.3, fontWeight: '900', color: semantic.text.primary },
  heroTitleItalic: { paddingBottom: 2, fontSize: 28, lineHeight: 31, letterSpacing: -1.3, fontWeight: '900', fontStyle: 'italic', color: semantic.text.primary },
  cardEyebrow: { fontFamily: 'monospace', fontSize: 14, lineHeight: 19, fontWeight: '900', textTransform: 'uppercase', color: semantic.text.primary },
  targetRule: { paddingTop: 8, fontSize: 12, lineHeight: 17, fontWeight: '700', color: semantic.text.dim },
  targetPriceText: { color: tokens.colors.accent, fontWeight: '900', fontVariant: ['tabular-nums'] },
  durationDial: { position: 'absolute', width: 96, height: 96, right: 12, top: 42, borderRadius: 48, alignItems: 'center', justifyContent: 'center' },
  durationValue: { fontFamily: 'monospace', fontSize: 10, fontWeight: '900', color: semantic.text.primary },
  dialCountdown: { paddingTop: 1, fontFamily: 'monospace', fontSize: 14, fontWeight: '900', fontVariant: ['tabular-nums'], color: semantic.text.primary },
  dialHint: { width: 52, paddingTop: 2, fontFamily: 'monospace', fontSize: 7, lineHeight: 8, textAlign: 'center', color: semantic.text.dim },
  dialCountdownClosed: { color: semantic.text.faint },
  settlingBanner: { marginHorizontal: 18, marginBottom: 12, padding: 10, flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 12, backgroundColor: tokens.colors.surface },
  settlingCopy: { flex: 1 },
  settlingTitle: { fontFamily: 'monospace', fontSize: 10, fontWeight: '800', color: semantic.text.primary },
  settlingText: { paddingTop: 2, fontFamily: 'monospace', fontSize: 9, color: semantic.text.dim },
  marketStage: { paddingTop: 12, backgroundColor: tokens.colors.ground, borderTopLeftRadius: 24, borderTopRightRadius: 24, borderCurve: 'continuous' },
  marketHeader: { minHeight: 56, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  priceLabel: { fontFamily: 'monospace', fontSize: 9, letterSpacing: 1.3, textTransform: 'uppercase', fontWeight: '800', color: semantic.text.dim },
  assetPrice: { paddingTop: 3, fontSize: 27, lineHeight: 30, letterSpacing: -0.8, fontWeight: '900', fontVariant: ['tabular-nums'], color: semantic.text.primary },
  surfaceTabs: { flexDirection: 'row', padding: 4, borderRadius: 14, borderCurve: 'continuous', backgroundColor: tokens.colors.lift },
  surfaceTab: { minWidth: 68, minHeight: 40, flexDirection: 'row', gap: 5, alignItems: 'center', justifyContent: 'center', borderRadius: 11, borderCurve: 'continuous' },
  surfaceTabActive: { backgroundColor: tokens.colors.accent },
  surfaceText: { fontFamily: 'monospace', fontSize: 9, fontWeight: '700', color: semantic.text.faint },
  surfaceTextActive: { color: tokens.colors.backgroundDark },
  marketSurface: { minHeight: 236, position: 'relative', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  surfaceState: { minHeight: 236, alignItems: 'center', justifyContent: 'center', gap: 8 },
  verdictOverlay: { position: 'absolute', right: 14, bottom: 8, alignItems: 'flex-end', paddingHorizontal: 9, paddingVertical: 6, borderRadius: 10, backgroundColor: 'rgba(3,31,44,0.72)' },
  verdictContext: { paddingTop: 1, fontFamily: 'monospace', fontSize: 9, fontWeight: '800', color: semantic.text.primary },
  verdictWord: { fontSize: 28, lineHeight: 29, fontWeight: '900', letterSpacing: -1, color: semantic.text.dim },
  positive: { color: tokens.colors.viridian },
  negative: { color: tokens.colors.vermillion },
  pickRow: { flexDirection: 'row', gap: 10, paddingHorizontal: 14, paddingVertical: 14, backgroundColor: tokens.colors.surface },
  pickButton: { flex: 1, minHeight: 88, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderRadius: 16, borderCurve: 'continuous', borderWidth: 1 },
  pickHigher: { backgroundColor: tokens.colors.ground, borderColor: semantic.predict.outcomeYesBorder },
  pickLower: { backgroundColor: tokens.colors.ground, borderColor: semantic.predict.outcomeNoBorder },
  pickHigherSelected: { backgroundColor: tokens.colors.viridian, borderColor: tokens.colors.viridian },
  pickLowerSelected: { backgroundColor: tokens.colors.vermillion, borderColor: tokens.colors.vermillion },
  pickCopy: { flex: 1, paddingRight: 6 },
  pickPrice: { fontFamily: 'monospace', fontSize: 20, fontWeight: '900', fontVariant: ['tabular-nums'] },
  higherPrice: { color: tokens.colors.viridian },
  lowerPrice: { color: tokens.colors.vermillion },
  pickLabel: { fontSize: 15, fontWeight: '900', textTransform: 'uppercase', color: semantic.text.primary },
  pickHelper: { paddingTop: 5, fontSize: 9, lineHeight: 12, fontWeight: '700', color: semantic.text.dim },
  pickTextSelected: { color: tokens.colors.backgroundDark },
  pickHelperSelected: { color: 'rgba(3,31,44,0.72)' },
  actionSection: { paddingHorizontal: 14, paddingTop: 2, paddingBottom: 14, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: semantic.border.muted, backgroundColor: tokens.colors.ground },
  makePickButton: { minHeight: 62, marginTop: 12, paddingHorizontal: 16, borderRadius: 16, borderCurve: 'continuous', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  makePickHigher: { backgroundColor: tokens.colors.viridian },
  makePickLower: { backgroundColor: tokens.colors.vermillion },
  makePickText: { fontSize: 12, fontWeight: '900', color: tokens.colors.backgroundDark },
  makePickReturn: { fontFamily: 'monospace', fontSize: 10, fontWeight: '700', color: 'rgba(3,31,44,0.72)' },
  disabled: { opacity: 0.45 },
  stateCard: { minHeight: 260, borderRadius: 24, borderCurve: 'continuous', borderWidth: 1, borderColor: semantic.border.muted, backgroundColor: tokens.colors.ground, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24 },
  stateCardInner: { minHeight: 420, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  stateTitle: { fontFamily: 'monospace', fontSize: 14, fontWeight: '800', textAlign: 'center', color: semantic.text.primary },
  stateCopy: { fontFamily: 'monospace', fontSize: 10, lineHeight: 15, textAlign: 'center', color: semantic.text.dim },
  retryButton: { minHeight: 44, borderRadius: 12, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: tokens.colors.primary },
  retryText: { fontFamily: 'monospace', fontSize: 10, fontWeight: '800', color: '#fff' },
  bookWrap: { width: '100%', flexDirection: 'row', gap: 10, paddingHorizontal: 14 },
  bookColumn: { flex: 1, minHeight: 202, padding: 10, borderRadius: 14, borderCurve: 'continuous', backgroundColor: tokens.colors.surface },
  bookTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingBottom: 8 },
  bookDot: { width: 7, height: 7, borderRadius: 4 },
  bookTitle: { fontFamily: 'monospace', fontSize: 10, fontWeight: '800', color: semantic.text.primary },
  bookHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', paddingBottom: 5 },
  bookHeader: { fontFamily: 'monospace', fontSize: 8, color: semantic.text.faint },
  bookLevelRow: { minHeight: 31, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: semantic.border.muted },
  bookPrice: { fontFamily: 'monospace', fontSize: 10, fontWeight: '800', fontVariant: ['tabular-nums'] },
  bookAvailable: { fontFamily: 'monospace', fontSize: 9, fontVariant: ['tabular-nums'], color: semantic.text.dim },
  bookEmpty: { paddingTop: 24, fontFamily: 'monospace', fontSize: 9, textAlign: 'center', color: semantic.text.faint },
  positionFace: { minHeight: 520, padding: 20 },
  positionOutcome: { paddingTop: 10, fontFamily: 'monospace', fontSize: 32, fontWeight: '900', color: semantic.text.primary },
  positionQuestion: { paddingTop: 5, fontFamily: 'monospace', fontSize: 10, lineHeight: 15, color: semantic.text.dim },
  pnlHero: { marginTop: 24, padding: 18, borderRadius: 18, backgroundColor: tokens.colors.surface },
  pnlLabel: { fontFamily: 'monospace', fontSize: 9, textTransform: 'uppercase', letterSpacing: 1, color: semantic.text.faint },
  pnlValue: { paddingTop: 5, fontFamily: 'monospace', fontSize: 30, fontWeight: '900', color: semantic.text.primary },
  positionGrid: { paddingTop: 10, flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  positionStat: { width: '48.7%', padding: 12, borderRadius: 13, backgroundColor: tokens.colors.surface },
  statLabel: { fontFamily: 'monospace', fontSize: 8, textTransform: 'uppercase', color: semantic.text.faint },
  statValue: { paddingTop: 4, fontFamily: 'monospace', fontSize: 13, fontWeight: '800', fontVariant: ['tabular-nums'], color: semantic.text.primary },
  positionActions: { paddingTop: 18, flexDirection: 'row', gap: 8 },
  secondaryButton: { flex: 1, minHeight: 50, borderRadius: 14, borderWidth: 1, borderColor: semantic.border.muted, alignItems: 'center', justifyContent: 'center' },
  secondaryButtonText: { fontFamily: 'monospace', fontSize: 10, fontWeight: '800', color: semantic.text.primary },
  primaryButton: { flex: 1, minHeight: 50, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: tokens.colors.primary },
  primaryButtonText: { fontFamily: 'monospace', fontSize: 10, fontWeight: '800', color: '#fff' },
  modalBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(3,31,44,0.74)' },
  bottomSheet: { paddingHorizontal: 20, paddingTop: 10, borderTopLeftRadius: 26, borderTopRightRadius: 26, backgroundColor: tokens.colors.ground },
  sheetGrabber: { alignSelf: 'center', width: 42, height: 4, borderRadius: 2, backgroundColor: semantic.text.faint, marginBottom: 14 },
  sheetEyebrow: { fontFamily: 'monospace', fontSize: 9, textTransform: 'uppercase', letterSpacing: 1.2, color: tokens.colors.accent },
  sheetTitle: { paddingTop: 4, fontFamily: 'monospace', fontSize: 20, fontWeight: '900', color: semantic.text.primary },
  sheetCopy: { paddingTop: 5, fontFamily: 'monospace', fontSize: 10, lineHeight: 15, color: semantic.text.dim },
  durationOption: { minHeight: 72, marginTop: 10, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', borderRadius: 16, borderWidth: 1, borderColor: semantic.border.muted, backgroundColor: tokens.colors.surface },
  durationOptionActive: { borderColor: tokens.colors.accent, backgroundColor: tokens.colors.lift },
  durationOptionCopy: { flex: 1 },
  durationOptionTitle: { fontFamily: 'monospace', fontSize: 13, fontWeight: '800', color: semantic.text.primary },
  durationOptionText: { paddingTop: 3, fontFamily: 'monospace', fontSize: 9, color: semantic.text.dim },
});
