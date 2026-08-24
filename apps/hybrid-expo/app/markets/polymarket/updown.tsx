import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppTopBar, AppTopBarCashPill, AppTopBarIconButton, AppTopBarTitle } from '@/components/AppTopBar';
import {
  fetchClobBalance,
  fetchLivePrices,
  fetchOrderbook,
  fetchUpDownRounds,
  placeBet,
  type UpDownRound,
} from '@/features/predict/predict.api';
import { usePolymarketWallet } from '@/hooks/usePolymarketWallet';
import { ConnectionSheet } from '@/features/wallet/components/ConnectionSheet';
import { useConnectionSheet } from '@/features/wallet/components/useConnectionSheet';
import { CycleChart, type CyclePoint } from '@/features/predict/components/CycleChart';
import { OrderbookView } from '@/features/predict/components/OrderbookView';
import { OrderComposerSheet } from '@/features/predict/components/OrderComposerSheet';
import type { ComposerMode } from '@/features/predict/components/OrderComposerSheet';
import { getBestAsk, buildExecutableBuyQuote } from '@/features/predict/orderbookQuote';
import { makePendingOpenOrder } from '@/features/predict/pendingOpenOrders';
import { truncateUsd } from '@/features/predict/formatPredictMoney';
import type { Orderbook } from '@/features/predict/predict.types';
import { semantic, tokens } from '@/theme';

/**
 * One Tap Up/Down (Predict redesign PRD §2).
 *
 * Binary higher/lower rounds on BTC/ETH mapped from Polymarket's hourly/daily
 * series. Asset + timeframe switchers; Chart/Book share one surface; Up/Down
 * opens the shared composer. Round close shows a neutral "Round closed"
 * settling state — never an instant result flash (honesty rule).
 */

type Asset = 'btc' | 'eth';
type Duration = 'hourly' | 'daily';
type Surface = 'chart' | 'book';
type Phase = 'loading' | 'open' | 'settling' | 'unavailable';

function formatCountdown(endMs: number, nowMs: number): string | null {
  const remaining = endMs - nowMs;
  if (!Number.isFinite(remaining) || remaining <= 0) return null;
  const totalSeconds = Math.floor(remaining / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
  return `${seconds}s`;
}

function roundPhase(round: UpDownRound | null, now: number): Phase {
  if (!round) return 'unavailable';
  if (round.closed || (round.endDate !== null && Date.parse(round.endDate) <= now)) return 'settling';
  return 'open';
}

export default function PredictUpDownScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const poly = usePolymarketWallet();
  const connectSheet = useConnectionSheet('evm');

  const [asset, setAsset] = useState<Asset>('btc');
  const [duration, setDuration] = useState<Duration>('hourly');
  const [surface, setSurface] = useState<Surface>('chart');
  const [rounds, setRounds] = useState<Awaited<ReturnType<typeof fetchUpDownRounds>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [priceHistory, setPriceHistory] = useState<CyclePoint[]>([]);
  const [orderbook, setOrderbook] = useState<Orderbook | null>(null);
  const [orderbookLoading, setOrderbookLoading] = useState(false);
  const [cashBalance, setCashBalance] = useState<number | null>(null);

  // Composer state
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerSide, setComposerSide] = useState<'up' | 'down'>('up');
  const [composerParams, setComposerParams] = useState<{ mode: ComposerMode; limitPriceCents: number } | null>(null);
  const [amount, setAmount] = useState('50');
  const [submitting, setSubmitting] = useState(false);
  const submitInFlightRef = useRef(false);

  const round = rounds?.[asset]?.[duration] ?? null;
  const phase = roundPhase(round, now);
  const upTokenId = round?.clobTokenIds[0];
  const downTokenId = round?.clobTokenIds[1];

  const loadRounds = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    if (!silent) setLoading(true);
    setErrorMessage(null);
    try {
      setRounds(await fetchUpDownRounds());
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to load rounds');
      setRounds(null);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => { void loadRounds(); }, [loadRounds]);

  // Clock tick drives the countdown + settling detection.
  useEffect(() => {
    const timer = globalThis.setInterval(() => setNow(Date.now()), 1_000);
    return () => globalThis.clearInterval(timer);
  }, []);

  // Live prices for the round's tokens (Up chance comes off the book first).
  const tokenKey = useMemo(
    () => [upTokenId, downTokenId].filter(Boolean).join(','),
    [upTokenId, downTokenId],
  );
  const livePricesRef = useRef<Record<string, number | null>>({});
  const [livePrices, setLivePrices] = useState<Record<string, number | null>>({});

  useEffect(() => {
    if (!tokenKey) return;
    let cancelled = false;
    async function poll() {
      try {
        const prices = await fetchLivePrices(tokenKey.split(',').filter(Boolean));
        if (!cancelled) {
          livePricesRef.current = { ...livePricesRef.current, ...prices };
          setLivePrices((prev) => ({ ...prev, ...prices }));
        }
      } catch { /* keep last known */ }
    }
    void poll();
    const timer = globalThis.setInterval(poll, 15_000);
    return () => {
      cancelled = true;
      globalThis.clearInterval(timer);
    };
  }, [tokenKey]);

  // Book polling for the selected side's executable quote.
  useEffect(() => {
    const tokenId = composerSide === 'down' ? downTokenId : upTokenId;
    if (!tokenId) return;
    const bookTokenId: string = tokenId;
    let cancelled = false;
    async function poll() {
      try {
        const book = await fetchOrderbook(bookTokenId);
        if (!cancelled) setOrderbook(book);
      } catch {
        if (!cancelled) setOrderbook(null);
      }
    }
    void poll();
    const timer = globalThis.setInterval(poll, 10_000);
    return () => {
      cancelled = true;
      globalThis.clearInterval(timer);
    };
  }, [upTokenId, downTokenId, composerSide]);

  // Cash balance
  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!poly.polygonAddress) {
        setCashBalance(null);
        return;
      }
      const balance = await fetchClobBalance(poly.polygonAddress).catch(() => null);
      if (!cancelled) setCashBalance(balance?.balance ?? null);
    }
    void run();
    return () => { cancelled = true; };
  }, [poly.polygonAddress]);

  // Price history for the chart: reuse the standard CLOB history endpoint on
  // the Up token (probability-based charting per PRD). Empty history renders
  // as an empty chart — never a synthetic line.
  useEffect(() => {
    const tokenId = upTokenId;
    if (!tokenId) {
      setPriceHistory([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const { fetchPriceHistory } = await import('@/features/predict/predict.api');
        const data = await fetchPriceHistory(tokenId, '1h');
        if (!cancelled) setPriceHistory(data.history.map((pt) => ({ t: pt.t * 1000, p: pt.p })));
      } catch {
        if (!cancelled) setPriceHistory([]);
      }
    })();
    return () => { cancelled = true; };
  }, [upTokenId]);

  const upBook = upTokenId && orderbook && composerSide === 'up' ? orderbook : null;
  const upPrice = (upTokenId ? getBestAsk(orderbook) ?? livePrices[upTokenId] ?? null : null) ?? round?.upPrice ?? null;
  const downPrice = round?.downPrice != null ? 1 - round.downPrice : (downTokenId ? livePrices[downTokenId] ?? null : null);
  const selectedPrice = composerSide === 'down' ? downPrice : upPrice;
  const amountNum = parseFloat(amount) || 0;
  const executableQuote = buildExecutableBuyQuote(upBook, amountNum);

  function openComposer(side: 'up' | 'down') {
    if (phase !== 'open' || submitting || submitInFlightRef.current) return;
    setComposerSide(side);
    setAmount('50');
    setComposerParams(null);
    setComposerOpen(true);
  }

  function closeComposer() {
    setComposerOpen(false);
    setComposerParams(null);
  }

  async function submitRoundOrder() {
    if (!round || !poly.signer || !poly.polygonAddress) return;
    if (submitting || submitInFlightRef.current) return;
    const spend = parseFloat(amount);
    if (!spend || spend <= 0) return;
    const tokenId = composerSide === 'down' ? downTokenId : upTokenId;
    if (!tokenId) return;
    const priceCents = composerParams?.mode === 'limit' ? composerParams.limitPriceCents : null;

    submitInFlightRef.current = true;
    setSubmitting(true);
    try {
      if (!poly.canSignLocally) await poly.enable();
      if (!poly.polygonAddress || !poly.signer) throw new Error('Wallet session not ready');

      const freshBook = await fetchOrderbook(tokenId).catch(() => null);
      const quote = buildExecutableBuyQuote(freshBook, spend);
      let price: number;
      let size: number;
      let orderType: 'FOK' | 'GTC';
      if (priceCents !== null) {
        price = priceCents / 100;
        size = spend / price;
        orderType = 'GTC';
      } else {
        if (!quote.executable || quote.limitPrice === null || quote.shares <= 0) {
          AlertNotFilled();
          return;
        }
        price = quote.limitPrice;
        size = quote.shares;
        orderType = 'FOK';
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
        orderType,
      });
      if (!result.success) throw new Error(result.error || 'Order failed');

      // Optimistic pending order so the pick shows immediately.
      makePendingOpenOrder({
        id: result.orderID ?? result.operationId,
        slug: round.slug,
        tokenID: tokenId,
        price,
        size,
        outcome: composerSide === 'up' ? 'Up' : 'Down',
      });

      closeComposer();
      const balance = await fetchClobBalance(poly.polygonAddress).catch(() => null);
      setCashBalance(balance?.balance ?? null);
      void loadRounds({ silent: true });
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Order failed');
    } finally {
      submitInFlightRef.current = false;
      setSubmitting(false);
    }
  }

  function AlertNotFilled() {
    alert('Not filled. Not enough liquidity at the current price. Try a smaller amount.');
  }

  const countdown = round?.endDate ? formatCountdown(Date.parse(round.endDate), now) : null;
  const chartWidth = 343;
  const targetPrice = priceHistory.length > 0 ? priceHistory[0].p : 0;
  const direction: 'up' | 'down' | null =
    upPrice !== null && targetPrice > 0 ? (upPrice >= targetPrice ? 'up' : 'down') : null;

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <AppTopBar
        left={<AppTopBarIconButton icon="arrow-back" onPress={() => router.back()} accessibilityLabel="Go back" />}
        center={<AppTopBarTitle align="left" tone="primary" uppercase={false}>One Tap · Up or Down</AppTopBarTitle>}
        right={<AppTopBarCashPill value={truncateUsd(cashBalance)} />}
      />

      {/* Switchers */}
      <View style={styles.switcherRow}>
        <View style={styles.segGroup}>
          {(['btc', 'eth'] as Asset[]).map((a) => (
            <Pressable
              key={a}
              accessibilityRole="tab"
              accessibilityLabel={`${a.toUpperCase()} rounds`}
              accessibilityState={{ selected: asset === a }}
              style={[styles.segBtn, asset === a && styles.segBtnActive]}
              onPress={() => setAsset(a)}>
              <Text style={[styles.segText, asset === a && styles.segTextActive]}>{a.toUpperCase()}</Text>
            </Pressable>
          ))}
        </View>
        <View style={styles.segGroup}>
          {(['hourly', 'daily'] as Duration[]).map((d) => (
            <Pressable
              key={d}
              accessibilityRole="tab"
              accessibilityLabel={d === 'hourly' ? '1 hour rounds' : '1 day rounds'}
              accessibilityState={{ selected: duration === d }}
              style={[styles.segBtn, duration === d && styles.segBtnActive]}
              onPress={() => setDuration(d)}>
              <Text style={[styles.segText, duration === d && styles.segTextActive]}>{d === 'hourly' ? '1H' : '1D'}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await loadRounds({ silent: true }); setRefreshing(false); }} tintColor={semantic.text.accent} />
        }>
        {loading ? (
          <View style={styles.stateWrap}>
            <ActivityIndicator size="small" color={semantic.text.accent} />
            <Text style={styles.stateText}>Loading round...</Text>
          </View>
        ) : errorMessage ? (
          <View style={styles.stateWrap}>
            <Text style={styles.stateTitle}>Rounds unavailable</Text>
            <Text style={styles.stateText}>{errorMessage}</Text>
            <Pressable accessibilityRole="button" style={styles.retryBtn} onPress={() => void loadRounds()}>
              <Text style={styles.retryText}>Try Again</Text>
            </Pressable>
          </View>
        ) : phase === 'unavailable' || !round ? (
          <View style={styles.stateWrap}>
            <Text style={styles.stateTitle}>No open round</Text>
            <Text style={styles.stateText}>
              No {duration === 'hourly' ? '1-hour' : '1-day'} {asset.toUpperCase()} round is accepting picks right now. Pull to refresh.
            </Text>
          </View>
        ) : (
          <>
            {/* Question + countdown */}
            <Text style={styles.question} numberOfLines={2}>{round.question}</Text>
            {countdown ? (
              <Text style={styles.countdown}>Closes in {countdown}</Text>
            ) : (
              <Text style={styles.settlingBadge}>Round closed — settling</Text>
            )}

            {/* Chart / Book switcher */}
            <View style={styles.surfaceRow}>
              <Pressable
                accessibilityRole="tab"
                accessibilityState={{ selected: surface === 'chart' }}
                style={[styles.surfaceTab, surface === 'chart' && styles.surfaceTabActive]}
                onPress={() => setSurface('chart')}>
                <Text style={[styles.segText, surface === 'chart' && styles.segTextActive]}>Chart</Text>
              </Pressable>
              <Pressable
                accessibilityRole="tab"
                accessibilityState={{ selected: surface === 'book' }}
                style={[styles.surfaceTab, surface === 'book' && styles.surfaceTabActive]}
                onPress={() => setSurface('book')}>
                <Text style={[styles.segText, surface === 'book' && styles.segTextActive]}>Book</Text>
              </Pressable>
            </View>

            {surface === 'chart' ? (
              <CycleChart
                previous={[]}
                current={priceHistory}
                targetPrice={targetPrice}
                roundStart={Date.parse(round.startDate ?? '') || now - 3_600_000}
                roundEnd={Date.parse(round.endDate ?? '') || now}
                now={now}
                width={chartWidth}
                direction={direction}
              />
            ) : (
              <OrderbookView book={orderbook} loading={orderbookLoading} />
            )}
          </>
        )}
      </ScrollView>

      {/* Up / Down buttons */}
      {phase === 'open' && round ? (
        <View style={styles.upDownRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Higher at ${upPrice !== null ? `${Math.round(upPrice * 100)}¢` : 'unavailable'}`}
            style={[styles.sideBtn, styles.sideBtnUp]}
            disabled={submitting}
            onPress={() => openComposer('up')}>
            <Text style={styles.sideBtnPrice}>{upPrice !== null ? `${Math.round(upPrice * 100)}¢` : '--'}</Text>
            <Text style={styles.sideBtnLabel}>HIGHER</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Lower at ${downPrice !== null ? `${Math.round(downPrice * 100)}¢` : 'unavailable'}`}
            style={[styles.sideBtn, styles.sideBtnDown]}
            disabled={submitting}
            onPress={() => openComposer('down')}>
            <Text style={styles.sideBtnPrice}>{downPrice !== null ? `${Math.round(downPrice * 100)}¢` : '--'}</Text>
            <Text style={styles.sideBtnLabel}>LOWER</Text>
          </Pressable>
        </View>
      ) : null}

      <OrderComposerSheet
        visible={composerOpen && round !== null}
        side="yes"
        pickLabel={composerSide === 'up' ? 'UP' : 'DOWN'}
        question={round?.question ?? null}
        currentPrice={selectedPrice}
        amount={amount}
        onAmountChange={setAmount}
        executableAvgPrice={executableQuote.executable && executableQuote.averagePrice !== null ? executableQuote.averagePrice : null}
        availableCash={cashBalance}
        submitting={submitting}
        disabled={!poly.isReady}
        onClose={closeComposer}
        onConfirm={(params) => {
          setComposerParams(params);
          void submitRoundOrder();
        }}
      />

      <ConnectionSheet
        visible={connectSheet.visible}
        chain={connectSheet.chain}
        onClose={() => connectSheet.close()}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: semantic.background.screen,
  },
  switcherRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  segGroup: {
    flexDirection: 'row',
    gap: 4,
    backgroundColor: tokens.colors.lift,
    borderRadius: 12,
    padding: 3,
  },
  segBtn: {
    minHeight: 36,
    paddingHorizontal: 14,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segBtnActive: {
    backgroundColor: tokens.colors.surface,
  },
  segText: {
    fontFamily: 'monospace',
    fontSize: 11,
    fontWeight: '700',
    color: semantic.text.faint,
  },
  segTextActive: {
    color: semantic.text.primary,
  },
  content: {
    paddingHorizontal: 16,
    paddingBottom: 140,
    gap: 12,
  },
  question: {
    fontFamily: 'monospace',
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '800',
    color: semantic.text.primary,
  },
  countdown: {
    fontFamily: 'monospace',
    fontSize: 11,
    fontWeight: '700',
    color: tokens.colors.accent,
    letterSpacing: 0.5,
  },
  settlingBadge: {
    fontFamily: 'monospace',
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1,
    color: semantic.text.dim,
  },
  surfaceRow: {
    flexDirection: 'row',
    gap: 4,
    backgroundColor: tokens.colors.lift,
    borderRadius: 12,
    padding: 3,
    alignSelf: 'flex-start',
  },
  surfaceTab: {
    minHeight: 36,
    paddingHorizontal: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  surfaceTabActive: {
    backgroundColor: tokens.colors.surface,
  },
  stateWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 60,
    paddingHorizontal: 24,
  },
  stateTitle: {
    fontFamily: 'monospace',
    fontSize: 14,
    fontWeight: '700',
    color: semantic.text.primary,
  },
  stateText: {
    fontFamily: 'monospace',
    fontSize: 11,
    lineHeight: 16,
    color: semantic.text.dim,
    textAlign: 'center',
  },
  retryBtn: {
    marginTop: 4,
    backgroundColor: semantic.text.accent,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
  },
  retryText: {
    fontFamily: 'monospace',
    fontSize: 11,
    fontWeight: '700',
    color: semantic.background.screen,
    textTransform: 'uppercase',
  },
  upDownRow: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 14,
    backgroundColor: tokens.colors.ground,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderColor: semantic.border.muted,
  },
  sideBtn: {
    flex: 1,
    height: 56,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  sideBtnUp: {
    backgroundColor: semantic.predict.outcomeYesBg,
  },
  sideBtnDown: {
    backgroundColor: semantic.predict.outcomeNoBg,
  },
  sideBtnPrice: {
    fontFamily: 'monospace',
    fontSize: 18,
    fontWeight: '700',
    color: semantic.sentiment.positive,
    lineHeight: 22,
  },
  sideBtnLabel: {
    fontFamily: 'monospace',
    fontSize: 9,
    letterSpacing: 1.5,
    color: semantic.text.dim,
  },
});
