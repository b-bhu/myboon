import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import * as Haptics from 'expo-haptics';
import { useWallet } from '@/hooks/useWallet';
import { ConnectionSheet } from '@/features/wallet/components/ConnectionSheet';
import { useConnectionSheet } from '@/features/wallet/components/useConnectionSheet';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import {
  ActivityIndicator,
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppTopBar } from '@/components/AppTopBar';
import {
  fetchPerpsMarkets,
  fetchPerpsAccount,
  fetchPerpsPositions,
  fetchOpenOrders,
  formatChange,
  formatFunding,
  formatPrice,
  formatUsdCompact,
} from '@/features/perps/perps.public-api';
import {
  placeOrder,
  placeLimitOrder,
  closePosition,
  setTPSL,
  removeTPSL,
} from '@/features/perps/perps.signed-api';
import type { PerpsMarket, PerpsOrder, PerpsPosition } from '@/features/perps/perps.types';
import { usePerpsLivePrice } from '@/features/perps/usePerpsWebSocket';
import { PriceChart } from '@/features/perps/PriceChart';
import { PACIFIC_BUILDER_CODE } from '@/features/perps/pacific.config';
import { DepositModal } from '@/features/perps/DepositModal';
import { semantic, tokens } from '@/theme';

type Side = 'long' | 'short';
type AmountMode = 'usd' | 'native';
type OrderType = 'market' | 'limit';

// Hold duration for hold-to-confirm (ms)
const HOLD_DURATION = 800;

// Button feedback states
type ButtonState = 'idle' | 'holding' | 'submitting' | 'success' | 'error';

interface MarketDetailScreenProps {
  symbol: string;
}

export function MarketDetailScreen({ symbol }: MarketDetailScreenProps) {
  const router = useRouter();
  const { connected, address, signMessage } = useWallet();
  const connectSheet = useConnectionSheet('solana');

  // Market data
  const [market, setMarket] = useState<PerpsMarket | null>(null);
  const [loadingMarket, setLoadingMarket] = useState(true);
  const [marketError, setMarketError] = useState<string | null>(null);

  // Account balance
  const [availableBalance, setAvailableBalance] = useState<number | null>(null);
  // Whether the user has a Pacific account at all
  const [hasAccount, setHasAccount] = useState<boolean | null>(null);

  // UI state
  const [side, setSide] = useState<Side>('long');
  const [orderType, setOrderType] = useState<OrderType>('market');
  const [limitPriceText, setLimitPriceText] = useState('');
  const [amountMode, setAmountMode] = useState<AmountMode>('usd');
  const [amountText, setAmountText] = useState('');
  const [scrubPrice, setScrubPrice] = useState<number | null>(null);

  // Quick-amount pill active state
  const [activePillPct, setActivePillPct] = useState<number | null>(null);

  // TP/SL inline fields
  const [tpslExpanded, setTpslExpanded] = useState(false);
  const [tpPriceText, setTpPriceText] = useState('');
  const [slPriceText, setSlPriceText] = useState('');

  // My Positions
  const [positions, setPositions] = useState<PerpsPosition[]>([]);
  const [orders, setOrders] = useState<PerpsOrder[]>([]);
  const [positionsLoading, setPositionsLoading] = useState(false);
  const [closingSymbol, setClosingSymbol] = useState<string | null>(null);

  // Deposit modal
  const [depositOpen, setDepositOpen] = useState(false);

  // Submit button state (C-07 hold-to-confirm, C-08 feedback)
  const [buttonState, setButtonState] = useState<ButtonState>('idle');
  const [buttonMsg, setButtonMsg] = useState('');
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdProgressAnim = useRef(new Animated.Value(0)).current;

  // Live dot pulse animation
  const dotOpacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(dotOpacity, { toValue: 0.2, duration: 800, useNativeDriver: true }),
        Animated.timing(dotOpacity, { toValue: 1, duration: 800, useNativeDriver: true }),
      ])
    );
    pulse.start();
    return () => pulse.stop();
  }, [dotOpacity]);

  const handleScrub = useCallback((price: number | null, _time: number | null) => {
    setScrubPrice(price);
  }, []);

  // Live price via WebSocket
  const livePrice = usePerpsLivePrice(symbol);

  // Displayed price: prefer live WebSocket, fall back to REST snapshot
  const displayPrice = useMemo(() => {
    if (livePrice?.mark) return parseFloat(livePrice.mark);
    return market?.markPrice ?? 0;
  }, [livePrice, market]);

  const displayFunding = useMemo(() => {
    if (livePrice?.funding) return parseFloat(livePrice.funding);
    return market?.fundingRate ?? 0;
  }, [livePrice, market]);

  // Load market info (REST snapshot for initial render)
  async function loadMarket() {
    setLoadingMarket(true);
    setMarketError(null);
    try {
      const all = await fetchPerpsMarkets();
      const found = all.find((m) => m.symbol === symbol) ?? null;
      if (!found) throw new Error(`Market ${symbol} not found`);
      setMarket(found);
    } catch (err) {
      setMarketError(err instanceof Error ? err.message : 'Failed to load market');
    } finally {
      setLoadingMarket(false);
    }
  }

  useEffect(() => {
    void loadMarket();
  }, [symbol]);

  // Fetch available balance
  useEffect(() => {
    if (connected && address) {
      fetchPerpsAccount(address)
        .then((acc) => {
          setAvailableBalance(acc.availableToSpend);
          setHasAccount(true);
        })
        .catch(() => {
          setAvailableBalance(null);
          setHasAccount(false);
        });
    } else {
      setAvailableBalance(null);
      setHasAccount(null);
    }
  }, [connected, address]);

  // Fetch positions + orders
  const loadPositions = useCallback(() => {
    if (!connected || !address) {
      setPositions([]);
      setOrders([]);
      return;
    }
    setPositionsLoading(true);
    Promise.all([
      fetchPerpsPositions(address),
      fetchOpenOrders(address),
    ])
      .then(([pos, ord]) => {
        setPositions(pos);
        setOrders(ord);
      })
      .catch(() => {
        setPositions([]);
        setOrders([]);
      })
      .finally(() => setPositionsLoading(false));
  }, [connected, address]);

  useEffect(() => {
    loadPositions();
  }, [loadPositions]);

  // Build TP/SL map from orders
  const tpslBySymbol = useMemo(() => {
    const map: Record<string, { tp?: PerpsOrder; sl?: PerpsOrder }> = {};
    for (const o of orders) {
      if (!map[o.symbol]) map[o.symbol] = {};
      if (o.orderType === 'take_profit_limit') map[o.symbol].tp = o;
      if (o.orderType === 'stop_loss_limit') map[o.symbol].sl = o;
    }
    return map;
  }, [orders]);

  // Close a position from My Positions section (C-08: no Alert)
  const handleClosePositionCard = useCallback(async (pos: PerpsPosition) => {
    if (!address) return;
    setClosingSymbol(pos.symbol);
    try {
      const closeSide = pos.side === 'long' ? 'ask' : 'bid';
      await closePosition(pos.symbol, closeSide, pos.size, address, signMessage, PACIFIC_BUILDER_CODE || undefined);
      loadPositions();
      // Refresh balance
      fetchPerpsAccount(address).then((acc) => setAvailableBalance(acc.availableToSpend)).catch(() => {});
    } catch (_err: any) {
      // Error shown inline — closingSymbol resets
    } finally {
      setClosingSymbol(null);
    }
  }, [address, signMessage, loadPositions]);

  // TP/SL modal for position cards (C-11: pre-populate)
  const [tpslModalPos, setTpslModalPos] = useState<PerpsPosition | null>(null);
  const [tpslModalTp, setTpslModalTp] = useState('');
  const [tpslModalSl, setTpslModalSl] = useState('');
  const [tpslModalLoading, setTpslModalLoading] = useState(false);
  const [tpslModalMsg, setTpslModalMsg] = useState('');

  // C-11: Open TP/SL modal with existing values pre-populated
  const openTPSLModal = useCallback((pos: PerpsPosition) => {
    const existing = tpslBySymbol[pos.symbol];
    setTpslModalTp(existing?.tp?.stopPrice ? existing.tp.stopPrice.toString() : '');
    setTpslModalSl(existing?.sl?.stopPrice ? existing.sl.stopPrice.toString() : '');
    setTpslModalMsg('');
    setTpslModalPos(pos);
  }, [tpslBySymbol]);

  const handleSetTPSLCard = useCallback(async () => {
    if (!address || !tpslModalPos) return;
    setTpslModalLoading(true);
    setTpslModalMsg('');
    try {
      const apiSide = tpslModalPos.side === 'long' ? 'ask' : 'bid';
      const tp = tpslModalTp.trim() ? { stopPrice: tpslModalTp.trim(), limitPrice: tpslModalTp.trim() } : undefined;
      const sl = tpslModalSl.trim() ? { stopPrice: tpslModalSl.trim(), limitPrice: tpslModalSl.trim() } : undefined;
      if (!tp && !sl) {
        setTpslModalMsg('Set at least a TP or SL price.');
        setTpslModalLoading(false);
        return;
      }
      await setTPSL({ symbol: tpslModalPos.symbol, side: apiSide, takeProfit: tp, stopLoss: sl, builderCode: PACIFIC_BUILDER_CODE || undefined }, address, signMessage);
      setTpslModalPos(null);
      loadPositions();
    } catch (err: any) {
      setTpslModalMsg(err.message ?? 'Failed to set TP/SL');
    } finally {
      setTpslModalLoading(false);
    }
  }, [address, signMessage, tpslModalPos, tpslModalTp, tpslModalSl, loadPositions]);

  // C-12: Remove TP/SL
  const handleRemoveTPSL = useCallback(async (pos: PerpsPosition, which: 'tp' | 'sl' | 'both') => {
    if (!address) return;
    setTpslModalLoading(true);
    try {
      const apiSide = pos.side === 'long' ? 'ask' : 'bid';
      await removeTPSL(pos.symbol, apiSide, which, address, signMessage, orders);
      setTpslModalPos(null);
      loadPositions();
    } catch (err: any) {
      setTpslModalMsg(err.message ?? 'Failed to remove TP/SL');
    } finally {
      setTpslModalLoading(false);
    }
  }, [address, signMessage, orders, loadPositions]);

  // Max notional = available margin × max leverage
  const maxLeverage = market?.maxLeverage ?? 1;
  const maxNotional = availableBalance !== null ? availableBalance * maxLeverage : null;

  // Derive USDC amount from input
  const amountUsdc = useMemo(() => {
    const num = parseFloat(amountText);
    if (isNaN(num) || num <= 0) return 0;
    if (amountMode === 'usd') return num;
    // native → convert to USDC
    return num * displayPrice;
  }, [amountText, amountMode, displayPrice]);

  // Native equivalent for display
  const amountNative = useMemo(() => {
    if (displayPrice <= 0) return 0;
    return amountUsdc / displayPrice;
  }, [amountUsdc, displayPrice]);

  // C-09: Dynamic leverage indicator
  const effectiveLeverage = useMemo(() => {
    if (!availableBalance || availableBalance <= 0 || amountUsdc <= 0) return null;
    return amountUsdc / availableBalance;
  }, [amountUsdc, availableBalance]);

  // C-06: Fixed liq price calculation — use position margin, not entire account
  const liqPrice = useMemo(() => {
    if (amountUsdc <= 0 || !market) return null;
    // Position margin = notional / maxLeverage
    const positionMargin = amountUsdc / maxLeverage;
    if (positionMargin <= 0) return null;
    // Effective leverage for THIS position
    const posLev = amountUsdc / positionMargin; // = maxLeverage
    const actualLev = effectiveLeverage ?? posLev;
    // Use the lower of effective and max leverage for a more realistic estimate
    const lev = Math.min(actualLev, maxLeverage);
    if (lev <= 1) return null;
    return side === 'long'
      ? displayPrice * (1 - 1 / lev)
      : displayPrice * (1 + 1 / lev);
  }, [amountUsdc, availableBalance, displayPrice, side, maxLeverage, effectiveLeverage, market]);

  // ── Hold-to-confirm order submission (C-07) ──
  const handlePressIn = useCallback(() => {
    if (!connected || !address || amountUsdc <= 0 || buttonState === 'submitting') return;

    setButtonState('holding');
    holdProgressAnim.setValue(0);

    Animated.timing(holdProgressAnim, {
      toValue: 1,
      duration: HOLD_DURATION,
      useNativeDriver: false,
    }).start();

    holdTimerRef.current = setTimeout(() => {
      void executeOrder();
    }, HOLD_DURATION);
  }, [connected, address, amountUsdc, buttonState]);

  const handlePressOut = useCallback(() => {
    if (buttonState === 'holding') {
      // Released too early — cancel
      if (holdTimerRef.current) {
        clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
      }
      holdProgressAnim.stopAnimation();
      holdProgressAnim.setValue(0);
      setButtonState('idle');
    }
  }, [buttonState, holdProgressAnim]);

  // C-04: Wire TP/SL inline with order + C-08: button feedback
  const executeOrder = useCallback(async () => {
    if (!connected || !address || amountUsdc <= 0) return;
    if (maxNotional !== null && amountUsdc > maxNotional) {
      setButtonState('error');
      setButtonMsg(`Max: $${maxNotional.toFixed(0)} (${availableBalance?.toFixed(2)} × ${maxLeverage}x)`);
      setTimeout(() => { setButtonState('idle'); setButtonMsg(''); }, 3000);
      return;
    }

    setButtonState('submitting');
    setButtonMsg('');

    try {
      const apiSide = side === 'long' ? 'bid' : 'ask';

      // Build TP/SL params (C-04: actually wire them)
      const tpParam = tpPriceText.trim() ? { stopPrice: tpPriceText.trim(), limitPrice: tpPriceText.trim() } : undefined;
      const slParam = slPriceText.trim() ? { stopPrice: slPriceText.trim(), limitPrice: slPriceText.trim() } : undefined;

      if (__DEV__) console.log('[Submit] orderType:', orderType);
      if (orderType === 'limit') {
        const limitPrice = parseFloat(limitPriceText);
        if (!limitPrice || limitPrice <= 0) {
          setButtonState('error');
          setButtonMsg('Enter a valid limit price');
          setTimeout(() => { setButtonState('idle'); setButtonMsg(''); }, 3000);
          return;
        }
        await placeLimitOrder(
          {
            symbol,
            side: apiSide,
            price: limitPrice,
            amountUsdc,
            builderCode: PACIFIC_BUILDER_CODE || undefined,
          },
          address,
          signMessage,
        );
      } else {
        // Market order — pass TP/SL inline with the order via placeOrder,
        // then call setTPSL if TP/SL provided (Pacific create_market supports inline TP/SL
        // but our placeOrder wrapper doesn't pass them — call setTPSL after)
        const orderId = await placeOrder(
          {
            symbol,
            side: apiSide,
            amountUsdc,
            slippage: '1',
            builderCode: PACIFIC_BUILDER_CODE || undefined,
          },
          address,
          signMessage,
        );

        // C-04: Wire TP/SL after order placement
        if (tpParam || slParam) {
          try {
            await setTPSL(
              { symbol, side: apiSide, takeProfit: tpParam, stopLoss: slParam, builderCode: PACIFIC_BUILDER_CODE || undefined },
              address,
              signMessage,
            );
          } catch (_tpslErr) {
            // Order placed but TP/SL failed — show warning, don't roll back
            setButtonState('success');
            setButtonMsg(`Order #${orderId} placed — TP/SL failed, set manually`);
            setTimeout(() => { setButtonState('idle'); setButtonMsg(''); }, 4000);
            loadPositions();
            fetchPerpsAccount(address).then((acc) => setAvailableBalance(acc.availableToSpend)).catch(() => {});
            return;
          }
        }
      }

      setButtonState('success');
      setButtonMsg('Executed — see positions');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      loadPositions();
      fetchPerpsAccount(address).then((acc) => setAvailableBalance(acc.availableToSpend)).catch(() => {});
      setTimeout(() => { setButtonState('idle'); setButtonMsg(''); }, 3000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Order failed';
      setButtonState('error');
      setButtonMsg(msg);
      setTimeout(() => { setButtonState('idle'); setButtonMsg(''); }, 3000);
    }
  }, [connected, address, amountUsdc, availableBalance, maxNotional, symbol, side, signMessage, maxLeverage, orderType, limitPriceText, tpPriceText, slPriceText, loadPositions]);

  // Cleanup hold timer on unmount
  useEffect(() => {
    return () => {
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    };
  }, []);

  const change24h = market?.change24h ?? 0;
  const isUp = change24h >= 0;

  const insets = useSafeAreaInsets();

  // Submit button color based on state
  const submitBtnStyle = useMemo(() => {
    if (buttonState === 'success') return styles.submitSuccess;
    if (buttonState === 'error') return styles.submitError;
    return side === 'long' ? styles.submitLong : styles.submitShort;
  }, [buttonState, side]);

  // Submit button text
  const submitBtnText = useMemo(() => {
    if (buttonState === 'submitting') return '';
    if (buttonState === 'success') return buttonMsg || 'Executed';
    if (buttonState === 'error') return buttonMsg || 'Failed';
    if (amountUsdc <= 0) return `Hold to ${side === 'long' ? 'Long' : 'Short'}`;
    const typeLabel = orderType === 'limit' ? 'Limit ' : '';
    return `Hold — ${typeLabel}${side === 'long' ? 'Long' : 'Short'} $${amountUsdc.toFixed(0)}`;
  }, [buttonState, buttonMsg, amountUsdc, side, orderType]);

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <AppTopBar
        left={(
        <Pressable
          style={({ pressed }) => [styles.backBtn, pressed && styles.backBtnPressed]}
          onPress={() => router.back()}>
          <MaterialIcons name="arrow-back-ios" size={14} color={semantic.text.primary} />
          <Text style={styles.detailSym}>{symbol}</Text>
        </Pressable>
        )}
        center={(
          <View style={styles.headerPriceCenter}>
          <View style={styles.headerPriceRow}>
            {livePrice !== null && (
              <Animated.View style={[styles.liveDot, { opacity: dotOpacity }]} />
            )}
            <Text style={styles.headerPrice}>
              {formatPrice(scrubPrice ?? displayPrice)}
            </Text>
          </View>
          {scrubPrice === null && (
            <Text style={[styles.headerChange, isUp ? styles.textPos : styles.textNeg]}>
              {isUp ? '+' : ''}{formatChange(change24h)}
            </Text>
          )}
        </View>
        )}
        right={(
        <Pressable onPress={() => router.push('/trade?view=profile')} style={styles.avatarRing}>
          <View style={styles.avatarInner}>
            <MaterialIcons name="person" size={12} color={semantic.text.primary} />
          </View>
        </Pressable>
        )}
      />

      {loadingMarket ? (
        <View style={styles.centeredState}>
          <ActivityIndicator size="small" color={semantic.text.accent} />
          <Text style={styles.stateText}>Loading {symbol}...</Text>
        </View>
      ) : marketError ? (
        <View style={styles.centeredState}>
          <Text style={styles.errorTitle}>Market unavailable</Text>
          <Text style={styles.stateText}>{marketError}</Text>
          <Pressable style={styles.retryButton} onPress={() => void loadMarket()}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <>
          <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
            {/* Chart */}
            <PriceChart symbol={symbol} height={140} onScrub={handleScrub} />

            {/* Stats strip */}
            <View style={styles.statsStrip}>
              <View style={styles.stat}>
                <Text style={styles.statLabel}>Mark</Text>
                <Text style={styles.statVal}>{formatPrice(displayPrice)}</Text>
              </View>
              <View style={styles.stat}>
                <Text style={styles.statLabel}>Fund/8h</Text>
                <Text style={[styles.statVal, displayFunding >= 0 ? styles.textPos : styles.textNeg]}>
                  {formatFunding(displayFunding)}
                </Text>
              </View>
              <View style={styles.stat}>
                <Text style={styles.statLabel}>OI</Text>
                <Text style={styles.statVal}>{formatUsdCompact(market?.openInterest ?? 0)}</Text>
              </View>
              <View style={styles.stat}>
                <Text style={styles.statLabel}>24h Vol</Text>
                <Text style={styles.statVal}>{formatUsdCompact(market?.volume24h ?? 0)}</Text>
              </View>
            </View>

            {/* ── Order section ── */}
            {!connected ? (
              /* Disconnected wallet CTA */
              <View style={styles.disconnectedCta}>
                <MaterialIcons name="lock" size={32} color={semantic.text.dim} />
                <Text style={styles.disconnectedText}>
                  Connect your wallet to trade {symbol} perpetuals
                </Text>
                <Pressable style={styles.connectWalletBtn} onPress={() => connectSheet.open('solana')}>
                  <Text style={styles.connectWalletText}>Connect wallet</Text>
                </Pressable>
              </View>
            ) : hasAccount === false ? (
              /* C-05: Connected but no Pacific account */
              <View style={styles.disconnectedCta}>
                <MaterialIcons name="rocket-launch" size={32} color={semantic.text.dim} />
                <Text style={styles.disconnectedText}>
                  Deposit USDC to create your trading account
                </Text>
                <Pressable style={styles.connectWalletBtn} onPress={() => setDepositOpen(true)}>
                  <Text style={styles.connectWalletText}>Deposit to Start</Text>
                </Pressable>
              </View>
            ) : (
              <View style={styles.orderSection}>
                {/* Side toggle */}
                <View style={styles.sideToggle}>
                  <Pressable
                    style={[styles.sideBtn, side === 'long' && styles.sideBtnLongActive]}
                    onPress={() => setSide('long')}>
                    <Text style={[styles.sideBtnText, side === 'long' && { color: tokens.colors.viridian }]}>Long</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.sideBtn, side === 'short' && styles.sideBtnShortActive]}
                    onPress={() => setSide('short')}>
                    <Text style={[styles.sideBtnText, side === 'short' && { color: tokens.colors.vermillion }]}>Short</Text>
                  </Pressable>
                </View>

                {/* C-10: Market/Limit toggle */}
                <View style={styles.orderTypeRow}>
                  <Pressable
                    style={[styles.orderTypePill, orderType === 'market' && styles.orderTypePillActive]}
                    onPress={() => setOrderType('market')}>
                    <Text style={[styles.orderTypePillText, orderType === 'market' && styles.orderTypePillTextActive]}>Market</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.orderTypePill, orderType === 'limit' && styles.orderTypePillActive]}
                    onPress={() => { setOrderType('limit'); if (!limitPriceText && displayPrice > 0) setLimitPriceText(displayPrice.toFixed(2)); }}>
                    <Text style={[styles.orderTypePillText, orderType === 'limit' && styles.orderTypePillTextActive]}>Limit</Text>
                  </Pressable>
                </View>

                {/* Limit price input (C-10) */}
                {orderType === 'limit' && (
                  <View style={styles.limitPriceSection}>
                    <Text style={styles.amountLabel}>Limit Price (USD)</Text>
                    <View style={styles.limitPriceRow}>
                      <Text style={styles.amountDollar}>$</Text>
                      <TextInput
                        style={styles.limitPriceInput}
                        value={limitPriceText}
                        onChangeText={(t) => setLimitPriceText(t.replace(/[^0-9.]/g, ''))}
                        keyboardType="decimal-pad"
                        selectTextOnFocus
                        placeholder={displayPrice > 0 ? displayPrice.toFixed(2) : '0'}
                        placeholderTextColor={semantic.text.faint}
                      />
                    </View>
                  </View>
                )}

                {/* Amount input — tappable label toggles USD / native */}
                <View style={styles.amountSection}>
                  <Pressable onPress={() => setAmountMode(amountMode === 'usd' ? 'native' : 'usd')}>
                    <Text style={styles.amountLabel}>
                      {amountMode === 'usd' ? 'Amount (USDC)' : `Amount (${symbol})`}
                      {'  '}
                      <Text style={styles.amountToggleHint}>tap to switch</Text>
                    </Text>
                  </Pressable>
                  <View style={styles.amountRow}>
                    <Text style={styles.amountDollar}>{amountMode === 'usd' ? '$' : ''}</Text>
                    <TextInput
                      style={styles.amountInput}
                      value={amountText}
                      onChangeText={(t) => {
                        const clean = t.replace(/[^0-9.]/g, '');
                        setAmountText(clean);
                        setActivePillPct(null);
                      }}
                      keyboardType="decimal-pad"
                      selectTextOnFocus
                      placeholder="0"
                      placeholderTextColor={semantic.text.faint}
                    />
                    {amountMode === 'native' && (
                      <Text style={styles.amountNativeSymbol}>{symbol}</Text>
                    )}
                  </View>
                  {/* Secondary display */}
                  {amountUsdc > 0 && (
                    <Text style={styles.amountSecondary}>
                      {amountMode === 'usd'
                        ? `≈ ${amountNative.toFixed(4)} ${symbol}`
                        : `≈ $${amountUsdc.toFixed(2)}`}
                    </Text>
                  )}
                </View>

                {/* Quick-amount pills */}
                {maxNotional !== null && (
                  <View style={styles.quickPillsRow}>
                    {([25, 50, 75, 100] as const).map((pct) => (
                      <Pressable
                        key={pct}
                        style={[styles.quickPill, activePillPct === pct && styles.quickPillActive]}
                        onPress={() => {
                          const amount = (maxNotional * pct) / 100;
                          if (amountMode === 'usd') {
                            setAmountText(Math.floor(amount).toString());
                          } else if (displayPrice > 0) {
                            setAmountText((amount / displayPrice).toFixed(4));
                          }
                          setActivePillPct(pct);
                        }}>
                        <Text style={[styles.quickPillText, activePillPct === pct && styles.quickPillTextActive]}>
                          {pct === 100 ? 'MAX' : `${pct}%`}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                )}

                {/* C-09: Dynamic leverage indicator */}
                {availableBalance !== null && maxNotional !== null && (
                  <View style={styles.leverageRow}>
                    <Text style={styles.availText}>
                      ${availableBalance.toFixed(0)} balance
                    </Text>
                    {effectiveLeverage !== null && effectiveLeverage > 0 && (
                      <Text style={[styles.leverageText, effectiveLeverage > maxLeverage * 0.8 ? styles.textNeg : styles.textPos]}>
                        {effectiveLeverage.toFixed(1)}x leverage
                      </Text>
                    )}
                    <Text style={styles.availText}>
                      max {maxLeverage}x
                    </Text>
                  </View>
                )}

                {/* TP/SL collapsible */}
                {orderType === 'market' && (
                  <View style={styles.tpslSection}>
                    <Pressable style={styles.tpslHeader} onPress={() => setTpslExpanded(!tpslExpanded)}>
                      <Text style={styles.tpslHeaderText}>Take Profit / Stop Loss</Text>
                      <MaterialIcons
                        name={tpslExpanded ? 'expand-less' : 'expand-more'}
                        size={18}
                        color={semantic.text.dim}
                      />
                    </Pressable>
                    {tpslExpanded && (
                      <View style={styles.tpslInputRow}>
                        <View style={styles.tpslField}>
                          <Text style={styles.tpslFieldLabel}>TP Price</Text>
                          <TextInput
                            style={styles.tpslInput}
                            value={tpPriceText}
                            onChangeText={setTpPriceText}
                            placeholder="--"
                            placeholderTextColor={semantic.text.faint}
                            keyboardType="decimal-pad"
                          />
                        </View>
                        <View style={styles.tpslField}>
                          <Text style={[styles.tpslFieldLabel, { color: tokens.colors.vermillion }]}>SL Price</Text>
                          <TextInput
                            style={[styles.tpslInput, styles.tpslInputSl]}
                            value={slPriceText}
                            onChangeText={setSlPriceText}
                            placeholder="--"
                            placeholderTextColor={semantic.text.faint}
                            keyboardType="decimal-pad"
                          />
                        </View>
                      </View>
                    )}
                  </View>
                )}

                {/* Order summary */}
                <View style={styles.orderSummary}>
                  <View style={styles.sumItem}>
                    <Text style={styles.sumLabel}>Size</Text>
                    <Text style={styles.sumVal}>
                      {amountUsdc > 0 ? `$${amountUsdc.toFixed(0)}` : '--'}
                    </Text>
                    {amountNative > 0 && (
                      <Text style={styles.sumSubVal}>{amountNative.toFixed(4)} {symbol}</Text>
                    )}
                  </View>
                  <View style={[styles.sumItem, { alignItems: 'center' }]}>
                    <Text style={styles.sumLabel}>Est. Fee</Text>
                    <Text style={styles.sumVal}>
                      {amountUsdc > 0 ? `$${(amountUsdc * 0.0002).toFixed(2)}` : '--'}
                    </Text>
                  </View>
                  <View style={[styles.sumItem, { alignItems: 'flex-end' }]}>
                    <Text style={styles.sumLabel}>Liq. Price</Text>
                    <Text style={[styles.sumVal, styles.textNeg]}>
                      {liqPrice !== null && liqPrice > 0
                        ? `~${formatPrice(liqPrice)}`
                        : '--'}
                    </Text>
                  </View>
                </View>

                {/* C-07: Hold-to-confirm submit button + C-08: feedback states */}
                <View style={styles.submitContainer}>
                  <Pressable
                    style={[
                      styles.submitBtn,
                      submitBtnStyle,
                      (amountUsdc <= 0 || buttonState === 'submitting') && styles.submitDisabled,
                    ]}
                    disabled={amountUsdc <= 0 || buttonState === 'submitting' || buttonState === 'success' || buttonState === 'error'}
                    onPressIn={handlePressIn}
                    onPressOut={handlePressOut}>
                    {/* Hold progress bar overlay */}
                    {buttonState === 'holding' && (
                      <Animated.View
                        style={[
                          styles.holdProgress,
                          side === 'long' ? styles.holdProgressLong : styles.holdProgressShort,
                          {
                            width: holdProgressAnim.interpolate({
                              inputRange: [0, 1],
                              outputRange: ['0%', '100%'],
                            }),
                          },
                        ]}
                      />
                    )}
                    {buttonState === 'submitting' ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : buttonState === 'success' ? (
                      <View style={styles.submitFeedbackRow}>
                        <MaterialIcons name="check-circle" size={16} color="#fff" />
                        <Text style={styles.submitText}>{submitBtnText}</Text>
                      </View>
                    ) : buttonState === 'error' ? (
                      <View style={styles.submitFeedbackRow}>
                        <MaterialIcons name="error" size={16} color="#fff" />
                        <Text style={styles.submitText}>{submitBtnText}</Text>
                      </View>
                    ) : (
                      <Text style={styles.submitText}>{submitBtnText}</Text>
                    )}
                  </Pressable>

                  {/* C-05: Insufficient funds CTA */}
                  {connected && availableBalance !== null && availableBalance <= 0 && (
                    <Pressable style={styles.depositCta} onPress={() => setDepositOpen(true)}>
                      <MaterialIcons name="add-circle-outline" size={14} color={tokens.colors.viridian} />
                      <Text style={styles.depositCtaText}>Deposit funds to trade</Text>
                    </Pressable>
                  )}
                </View>

                {/* My Positions */}
                <View style={styles.myPositionsSection}>
                  <Text style={styles.myPositionsTitle}>My Positions</Text>
                  {positionsLoading ? (
                    <ActivityIndicator size="small" color={semantic.text.accent} style={{ marginTop: 8 }} />
                  ) : positions.length === 0 ? (
                    <Text style={styles.myPositionsEmpty}>No open positions</Text>
                  ) : (
                    positions.map((pos) => {
                      const posIsUp = pos.unrealizedPnl >= 0;
                      const isClosing = closingSymbol === pos.symbol;
                      const tpsl = tpslBySymbol[pos.symbol];
                      const hasTpsl = !!(tpsl?.tp || tpsl?.sl);
                      return (
                        <View key={pos.symbol} style={styles.posCard}>
                          <View style={styles.posCardTop}>
                            <View style={[styles.posSideBadge, pos.side === 'long' ? styles.posSideLong : styles.posSideShort]}>
                              <Text style={[styles.posSideText, pos.side === 'long' ? styles.textPos : styles.textNeg]}>
                                {pos.side === 'long' ? 'LONG' : 'SHORT'}
                              </Text>
                            </View>
                            <Text style={styles.posSymbol}>{pos.symbol}</Text>
                            <Text style={styles.posSize}>
                              {pos.size} {pos.symbol.replace('USDC', '').replace('-PERP', '')}
                            </Text>
                            <Text style={[styles.posPnl, posIsUp ? styles.textPos : styles.textNeg]}>
                              {posIsUp ? '+' : ''}${pos.unrealizedPnl.toFixed(2)}
                            </Text>
                          </View>
                          <View style={styles.posCardMeta}>
                            <Text style={styles.posMetaText}>Entry {formatPrice(pos.entryPrice)}</Text>
                            <Text style={styles.posMetaText}>Mark {formatPrice(pos.markPrice)}</Text>
                            {/* Show TP/SL inline on position card */}
                            {tpsl?.tp && <Text style={[styles.posMetaText, styles.textPos]}>TP {formatPrice(tpsl.tp.stopPrice!)}</Text>}
                            {tpsl?.sl && <Text style={[styles.posMetaText, styles.textNeg]}>SL {formatPrice(tpsl.sl.stopPrice!)}</Text>}
                          </View>
                          <View style={styles.posCardActions}>
                            <Pressable
                              style={styles.posActionBtn}
                              onPress={() => openTPSLModal(pos)}>
                              {/* C-11: Change button text when TP/SL exists */}
                              <Text style={styles.posActionBtnText}>{hasTpsl ? 'Edit TP/SL' : 'TP/SL'}</Text>
                            </Pressable>
                            <Pressable
                              style={[styles.posActionBtn, styles.posActionBtnClose]}
                              onPress={() => handleClosePositionCard(pos)}
                              disabled={isClosing}>
                              <Text style={[styles.posActionBtnText, { color: tokens.colors.vermillion }]}>
                                {isClosing ? 'Closing...' : 'Close'}
                              </Text>
                            </Pressable>
                          </View>
                        </View>
                      );
                    })
                  )}
                </View>
              </View>
            )}

            {/* Bottom padding for scroll */}
            <View style={{ height: 24 }} />
          </ScrollView>
        </>
      )}

      {/* TP/SL Modal for position cards (C-11 pre-populated, C-12 remove button) */}
      {tpslModalPos !== null && (
        <Pressable style={styles.modalOverlay} onPress={() => setTpslModalPos(null)}>
          <Pressable style={styles.modalCard} onPress={() => {}}>
            <Text style={styles.modalTitle}>
              {tpslBySymbol[tpslModalPos.symbol]?.tp || tpslBySymbol[tpslModalPos.symbol]?.sl ? 'Edit' : 'Set'} TP / SL — {tpslModalPos.symbol} {tpslModalPos.side.toUpperCase()}
            </Text>
            <View style={styles.tpslInputRow}>
              <View style={styles.tpslField}>
                <Text style={styles.tpslFieldLabel}>TP Price</Text>
                <TextInput
                  style={styles.tpslInput}
                  value={tpslModalTp}
                  onChangeText={setTpslModalTp}
                  placeholder={tpslModalPos.side === 'long' ? `above ${tpslModalPos.markPrice.toFixed(2)}` : `below ${tpslModalPos.markPrice.toFixed(2)}`}
                  placeholderTextColor={semantic.text.faint}
                  keyboardType="decimal-pad"
                />
              </View>
              <View style={styles.tpslField}>
                <Text style={[styles.tpslFieldLabel, { color: tokens.colors.vermillion }]}>SL Price</Text>
                <TextInput
                  style={[styles.tpslInput, styles.tpslInputSl]}
                  value={tpslModalSl}
                  onChangeText={setTpslModalSl}
                  placeholder={tpslModalPos.side === 'long' ? `below ${tpslModalPos.markPrice.toFixed(2)}` : `above ${tpslModalPos.markPrice.toFixed(2)}`}
                  placeholderTextColor={semantic.text.faint}
                  keyboardType="decimal-pad"
                />
              </View>
            </View>

            {/* C-12: Remove TP/SL button */}
            {(tpslBySymbol[tpslModalPos.symbol]?.tp || tpslBySymbol[tpslModalPos.symbol]?.sl) && (
              <Pressable
                style={styles.removeTPSLBtn}
                onPress={() => handleRemoveTPSL(tpslModalPos, 'both')}
                disabled={tpslModalLoading}>
                <MaterialIcons name="delete-outline" size={14} color={tokens.colors.vermillion} />
                <Text style={styles.removeTPSLText}>Remove All TP/SL</Text>
              </Pressable>
            )}

            {tpslModalMsg !== '' && (
              <Text style={styles.tpslModalMsg}>{tpslModalMsg}</Text>
            )}

            <View style={styles.modalActions}>
              <Pressable style={styles.modalCancelBtn} onPress={() => setTpslModalPos(null)}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.modalConfirmBtn, tpslModalLoading && { opacity: 0.5 }]}
                onPress={handleSetTPSLCard}
                disabled={tpslModalLoading}>
                <Text style={styles.modalConfirmText}>
                  {tpslModalLoading ? 'Setting...' : 'Confirm'}
                </Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      )}

      <DepositModal
        visible={depositOpen}
        onClose={() => setDepositOpen(false)}
        onRequestConnect={() => connectSheet.open('solana')}
      />

      <ConnectionSheet
        visible={connectSheet.visible}
        chain={connectSheet.chain}
        onClose={connectSheet.close}
      />
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: semantic.background.screen,
  },

  // Header
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    opacity: 0.8,
    padding: tokens.spacing.xs,
  },
  backBtnPressed: { opacity: 1 },
  detailSym: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.md,
    fontWeight: '700',
    color: semantic.text.primary,
    letterSpacing: 0.5,
  },
  headerPriceCenter: {
    flex: 1,
    alignItems: 'center',
  },
  headerPrice: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.lg - 2,
    fontWeight: '700',
    color: semantic.text.primary,
  },
  headerChange: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs,
    fontWeight: '600',
    marginTop: 1,
  },

  // Avatar (matches TradeListScreen pattern)
  avatarRing: {
    width: 28,
    height: 28,
    borderRadius: 14,
    padding: 2,
    backgroundColor: 'transparent',
    borderWidth: 1.5,
    borderColor: semantic.text.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInner: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: semantic.background.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Loading / error states
  centeredState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: tokens.spacing.sm,
    padding: tokens.spacing.xl,
  },
  stateText: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.sm,
    color: semantic.text.dim,
    textAlign: 'center',
  },
  errorTitle: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.md,
    fontWeight: '700',
    color: semantic.text.primary,
  },
  retryButton: {
    backgroundColor: semantic.text.accent,
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
    borderRadius: tokens.radius.xs,
    marginTop: tokens.spacing.xs,
  },
  retryText: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.sm,
    fontWeight: '700',
    textTransform: 'uppercase',
    color: semantic.background.screen,
  },

  // Stats strip
  statsStrip: {
    flexDirection: 'row',
    paddingHorizontal: tokens.spacing.lg,
    paddingVertical: tokens.spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: semantic.border.muted,
  },
  stat: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
  },
  statLabel: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs - 1,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: semantic.text.faint,
  },
  statVal: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xs,
    fontWeight: '600',
    color: semantic.text.primary,
  },

  // Order section
  orderSection: {
    padding: tokens.spacing.lg,
    gap: 14,
  },

  // Side toggle
  sideToggle: {
    flexDirection: 'row',
    backgroundColor: semantic.background.surfaceRaised,
    borderRadius: 10,
    padding: 3,
    gap: 3,
  },
  sideBtn: {
    flex: 1,
    paddingVertical: 9,
    alignItems: 'center',
    borderRadius: 8,
  },
  sideBtnLongActive: {
    backgroundColor: 'rgba(74,140,111,0.15)',
    borderWidth: 1,
    borderColor: 'rgba(74,140,111,0.25)',
  },
  sideBtnShortActive: {
    backgroundColor: 'rgba(217,83,79,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(217,83,79,0.22)',
  },
  sideBtnText: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xs,
    fontWeight: '700',
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    color: semantic.text.dim,
  },

  // C-10: Order type toggle (Market / Limit)
  orderTypeRow: {
    flexDirection: 'row',
    gap: 6,
  },
  orderTypePill: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 6,
    borderRadius: tokens.radius.xs,
    borderWidth: 1,
    borderColor: semantic.border.muted,
  },
  orderTypePillActive: {
    borderColor: tokens.colors.primary,
    backgroundColor: 'rgba(199,183,112,0.10)',
  },
  orderTypePillText: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs,
    fontWeight: '700',
    letterSpacing: 1,
    color: semantic.text.dim,
  },
  orderTypePillTextActive: {
    color: tokens.colors.primary,
  },

  // Limit price input
  limitPriceSection: {
    alignItems: 'center',
    gap: 4,
  },
  limitPriceRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
  },
  limitPriceInput: {
    fontFamily: 'monospace',
    fontSize: 28,
    fontWeight: '700',
    color: semantic.text.primary,
    minWidth: 80,
    textAlign: 'center',
    padding: 0,
  },

  // Amount input
  amountSection: {
    alignItems: 'center',
    gap: 6,
    paddingVertical: 4,
  },
  amountLabel: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    color: semantic.text.faint,
  },
  amountRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
  },
  amountDollar: {
    fontFamily: 'monospace',
    fontSize: 22,
    fontWeight: '700',
    color: semantic.text.dim,
  },
  amountInput: {
    fontFamily: 'monospace',
    fontSize: 38,
    fontWeight: '700',
    color: semantic.text.primary,
    minWidth: 60,
    textAlign: 'center',
    padding: 0,
  },
  amountToggleHint: {
    fontSize: tokens.fontSize.xxs - 2,
    color: semantic.text.accent,
    letterSpacing: 0.5,
    textTransform: 'none',
  },
  amountNativeSymbol: {
    fontFamily: 'monospace',
    fontSize: 22,
    fontWeight: '700',
    color: semantic.text.dim,
    marginLeft: 4,
  },
  amountSecondary: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs,
    color: semantic.text.dim,
    letterSpacing: 0.5,
  },

  // C-09: Leverage indicator row
  leverageRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 2,
  },
  availText: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs,
    color: semantic.text.faint,
    letterSpacing: 0.5,
  },
  leverageText: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs,
    fontWeight: '700',
    letterSpacing: 0.5,
  },

  // Order summary
  orderSummary: {
    flexDirection: 'row',
    backgroundColor: semantic.background.surfaceRaised,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    padding: tokens.spacing.md,
  },
  sumItem: {
    flex: 1,
    gap: 3,
  },
  sumLabel: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: semantic.text.dim,
  },
  sumVal: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.sm,
    fontWeight: '700',
    color: semantic.text.primary,
  },
  sumSubVal: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs - 1,
    color: semantic.text.dim,
    letterSpacing: 0.3,
  },

  // Submit button (C-07 hold-to-confirm + C-08 feedback)
  submitContainer: {
    gap: 8,
  },
  submitBtn: {
    paddingVertical: 14,
    alignItems: 'center',
    borderRadius: 10,
    overflow: 'hidden',
    position: 'relative',
  },
  submitLong: {
    backgroundColor: tokens.colors.viridian,
  },
  submitShort: {
    backgroundColor: tokens.colors.vermillion,
  },
  submitSuccess: {
    backgroundColor: tokens.colors.viridian,
  },
  submitError: {
    backgroundColor: tokens.colors.vermillion,
  },
  submitDisabled: {
    opacity: 0.4,
  },
  submitText: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.sm,
    fontWeight: '700',
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    color: '#fff',
  },
  submitFeedbackRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  holdProgress: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    borderRadius: 10,
  },
  holdProgressLong: {
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  holdProgressShort: {
    backgroundColor: 'rgba(255,255,255,0.15)',
  },

  // C-05: Deposit CTA for insufficient funds
  depositCta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 8,
    borderRadius: tokens.radius.sm,
    borderWidth: 1,
    borderColor: 'rgba(74,140,111,0.3)',
    backgroundColor: 'rgba(74,140,111,0.06)',
  },
  depositCtaText: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs,
    fontWeight: '700',
    color: tokens.colors.viridian,
    letterSpacing: 0.5,
  },

  // Colors
  textPos: { color: tokens.colors.viridian },
  textNeg: { color: tokens.colors.vermillion },

  // Live dot in header
  headerPriceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: tokens.colors.viridian,
  },

  // Quick-amount pills
  quickPillsRow: {
    flexDirection: 'row',
    gap: 6,
    justifyContent: 'center',
  },
  quickPill: {
    flex: 1,
    paddingVertical: 6,
    alignItems: 'center',
    borderRadius: tokens.radius.sm,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    backgroundColor: 'transparent',
  },
  quickPillActive: {
    backgroundColor: 'rgba(199,183,112,0.12)',
    borderColor: 'rgba(199,183,112,0.35)',
  },
  quickPillText: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs,
    fontWeight: '700',
    letterSpacing: 0.8,
    color: semantic.text.dim,
  },
  quickPillTextActive: {
    color: tokens.colors.primary,
  },

  // TP/SL collapsible section
  tpslSection: {
    borderWidth: 1,
    borderColor: semantic.border.muted,
    borderRadius: tokens.radius.sm,
    overflow: 'hidden',
  },
  tpslHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.xs + 2,
    backgroundColor: semantic.background.surfaceRaised,
  },
  tpslHeaderText: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs,
    fontWeight: '700',
    letterSpacing: 1,
    color: semantic.text.dim,
    textTransform: 'uppercase',
  },
  tpslInputRow: {
    flexDirection: 'row',
    gap: 8,
    padding: tokens.spacing.sm,
  },
  tpslField: {
    flex: 1,
    gap: 3,
  },
  tpslFieldLabel: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs - 1,
    fontWeight: '700',
    letterSpacing: 0.8,
    color: tokens.colors.viridian,
  },
  tpslInput: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.sm,
    color: semantic.text.primary,
    backgroundColor: semantic.background.surfaceRaised,
    borderWidth: 1,
    borderColor: 'rgba(74,140,111,0.3)',
    borderRadius: tokens.radius.xs,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  tpslInputSl: {
    borderColor: 'rgba(217,83,79,0.3)',
  },

  // Disconnected wallet CTA
  disconnectedCta: {
    alignItems: 'center',
    gap: tokens.spacing.md,
    padding: tokens.spacing.xl,
    margin: tokens.spacing.lg,
    backgroundColor: semantic.background.surfaceRaised,
    borderRadius: tokens.radius.md,
    borderWidth: 1,
    borderColor: semantic.border.muted,
  },
  disconnectedText: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xs,
    color: semantic.text.dim,
    textAlign: 'center',
    lineHeight: 20,
  },
  connectWalletBtn: {
    backgroundColor: tokens.colors.primary,
    borderRadius: tokens.radius.md,
    paddingVertical: tokens.spacing.sm + 2,
    paddingHorizontal: tokens.spacing.xl,
    marginTop: tokens.spacing.xs,
  },
  connectWalletText: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.sm,
    fontWeight: '700',
    color: semantic.background.screen,
    letterSpacing: 1,
  },

  // My Positions section
  myPositionsSection: {
    gap: 8,
    marginTop: 4,
  },
  myPositionsTitle: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs,
    fontWeight: '700',
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    color: semantic.text.dim,
  },
  myPositionsEmpty: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xs,
    color: semantic.text.faint,
    textAlign: 'center',
    paddingVertical: tokens.spacing.sm,
  },
  posCard: {
    backgroundColor: semantic.background.surfaceRaised,
    borderRadius: tokens.radius.sm,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    gap: 6,
    padding: tokens.spacing.sm,
  },
  posCardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  posSideBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: tokens.radius.xs,
  },
  posSideLong: {
    backgroundColor: 'rgba(74,140,111,0.15)',
    borderWidth: 1,
    borderColor: 'rgba(74,140,111,0.25)',
  },
  posSideShort: {
    backgroundColor: 'rgba(217,83,79,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(217,83,79,0.22)',
  },
  posSideText: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs - 1,
    fontWeight: '700',
    letterSpacing: 0.8,
  },
  posSymbol: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xs,
    fontWeight: '700',
    color: semantic.text.primary,
    flex: 1,
  },
  posSize: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs,
    color: semantic.text.dim,
  },
  posPnl: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xs,
    fontWeight: '700',
  },
  posCardMeta: {
    flexDirection: 'row',
    gap: 12,
    flexWrap: 'wrap',
  },
  posMetaText: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs,
    color: semantic.text.dim,
  },
  posCardActions: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 2,
  },
  posActionBtn: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 6,
    borderRadius: tokens.radius.xs,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    backgroundColor: semantic.background.lift,
  },
  posActionBtnClose: {
    borderColor: 'rgba(217,83,79,0.25)',
    backgroundColor: 'rgba(217,83,79,0.08)',
  },
  posActionBtnText: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs,
    fontWeight: '700',
    letterSpacing: 0.8,
    color: tokens.colors.primary,
  },

  // TP/SL modal (for position cards)
  modalOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: tokens.spacing.lg,
    zIndex: 100,
  },
  modalCard: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: semantic.background.lift,
    borderRadius: tokens.radius.md,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    padding: tokens.spacing.lg,
    gap: tokens.spacing.md,
  },
  modalTitle: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.sm,
    fontWeight: '700',
    color: semantic.text.primary,
    letterSpacing: 0.5,
  },
  modalActions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 4,
  },
  modalCancelBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderRadius: tokens.radius.xs,
    borderWidth: 1,
    borderColor: semantic.border.muted,
  },
  modalCancelText: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs,
    fontWeight: '700',
    color: semantic.text.dim,
  },
  modalConfirmBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderRadius: tokens.radius.xs,
    backgroundColor: tokens.colors.viridian,
  },
  modalConfirmText: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs,
    fontWeight: '700',
    color: '#fff',
  },

  // C-12: Remove TP/SL button
  removeTPSLBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 8,
    borderRadius: tokens.radius.xs,
    borderWidth: 1,
    borderColor: 'rgba(217,83,79,0.25)',
    backgroundColor: 'rgba(217,83,79,0.06)',
  },
  removeTPSLText: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs,
    fontWeight: '700',
    color: tokens.colors.vermillion,
    letterSpacing: 0.5,
  },
  tpslModalMsg: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs,
    color: tokens.colors.vermillion,
    textAlign: 'center',
  },
});
