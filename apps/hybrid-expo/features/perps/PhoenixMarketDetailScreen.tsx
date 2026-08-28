import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'expo-router';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppTopBar } from '@/components/AppTopBar';
import { useWallet } from '@/hooks/useWallet';
import { ConnectionSheet } from '@/features/wallet/components/ConnectionSheet';
import { useConnectionSheet } from '@/features/wallet/components/useConnectionSheet';
import { formatUsdCompact } from '@/lib/format';
import {
  buildPhoenixCancelConditionalOrder,
  buildPhoenixMarketOrder,
  buildPhoenixPositionConditionalOrder,
  fetchPhoenixMarket,
  fetchPhoenixTraderState,
  formatPhoenixPercent,
  formatPhoenixPrice,
  formatPhoenixRate,
  type PhoenixMarket,
  type PhoenixTraderState,
} from '@/features/perps/phoenix.api';
import {
  getPhoenixExecutionReadiness,
  placePhoenixOrder,
  sendPhoenixBuiltTransaction,
  type PhoenixExecutionContext,
} from '@/features/perps/phoenix.execution';
import { PhoenixPriceChart } from '@/features/perps/PhoenixPriceChart';
import { isBitcoinPerpSymbol } from '@/features/perps/btc-demo-events';
import { semantic, tokens } from '@/theme';

type Side = 'long' | 'short';
type OrderType = 'market' | 'limit';
type AmountMode = 'usd' | 'base';
type PendingDetailPositionAction =
  | {
    id: string;
    kind: 'close_position';
    positionId: string;
    signature: string;
    createdAt: number;
  }
  | {
    id: string;
    kind: 'set_tpsl';
    positionId: string;
    signature: string;
    takeProfitPrice?: number;
    stopLossPrice?: number;
    createdAt: number;
  }
  | {
    id: string;
    kind: 'clear_tpsl';
    positionId: string;
    clearKind: 'take_profit' | 'stop_loss';
    signature: string;
    createdAt: number;
  };

interface PendingDetailOrderPlacement {
  id: string;
  side: Side;
  orderType: OrderType;
  amountBase: number;
  amountUsdc: number;
  signature: string;
  createdAt: number;
}

interface PhoenixPositionRow {
  id: string;
  symbol: string;
  side: Side;
  size: number;
  entryPrice: number | null;
  markPrice: number | null;
  liquidationPrice: number | null;
  unrealizedPnl: number | null;
  notionalUsd: number | null;
  takeProfitPrice: number | null;
  stopLossPrice: number | null;
  takeProfitCancel: PhoenixConditionalCancelParams | null;
  stopLossCancel: PhoenixConditionalCancelParams | null;
  traderPdaIndex: number;
  traderSubaccountIndex: number;
}

interface PhoenixConditionalCancelParams {
  conditionalOrderIndex: number;
  executionDirection: string;
}

interface PhoenixMarketDetailScreenProps {
  symbol: string;
}

export function PhoenixMarketDetailScreen({ symbol }: PhoenixMarketDetailScreenProps) {
  const router = useRouter();
  const wallet = useWallet();
  const connectSheet = useConnectionSheet('solana');
  const insets = useSafeAreaInsets();

  const [market, setMarket] = useState<PhoenixMarket | null>(null);
  const [loadingMarket, setLoadingMarket] = useState(true);
  const [marketError, setMarketError] = useState<string | null>(null);
  const [latestPrice, setLatestPrice] = useState<number | null>(null);
  const [scrubPrice, setScrubPrice] = useState<number | null>(null);
  const [side, setSide] = useState<Side>('long');
  const [orderType, setOrderType] = useState<OrderType>('market');
  const [amountMode, setAmountMode] = useState<AmountMode>('usd');
  const [amountText, setAmountText] = useState('');
  const [limitPriceText, setLimitPriceText] = useState('');
  const [tpslExpanded, setTpslExpanded] = useState(false);
  const [tpPriceText, setTpPriceText] = useState('');
  const [slPriceText, setSlPriceText] = useState('');
  const [ticketMessage, setTicketMessage] = useState<string | null>(null);
  const [ticketBusy, setTicketBusy] = useState(false);
  const [positions, setPositions] = useState<PhoenixPositionRow[]>([]);
  const [positionsLoading, setPositionsLoading] = useState(false);
  const [positionActionMessage, setPositionActionMessage] = useState<string | null>(null);
  const [closingPositionId, setClosingPositionId] = useState<string | null>(null);
  const [clearingTpslKey, setClearingTpslKey] = useState<string | null>(null);
  const [tpslModalPosition, setTpslModalPosition] = useState<PhoenixPositionRow | null>(null);
  const [tpslModalTp, setTpslModalTp] = useState('');
  const [tpslModalSl, setTpslModalSl] = useState('');
  const [tpslModalMessage, setTpslModalMessage] = useState('');
  const [tpslModalBusy, setTpslModalBusy] = useState(false);
  const [pendingPositionActions, setPendingPositionActions] = useState<PendingDetailPositionAction[]>([]);
  const [pendingOrderPlacements, setPendingOrderPlacements] = useState<PendingDetailOrderPlacement[]>([]);

  const phoenixSignAndSendTransaction = useMemo<NonNullable<PhoenixExecutionContext['signAndSendTransaction']> | null>(() => {
    if (typeof wallet.signAndSendTransaction !== 'function') return null;

    return async (transaction) => {
      const result = await (wallet.signAndSendTransaction as (
        tx: unknown,
        minContextSlot?: number,
      ) => Promise<unknown>)(transaction, 0);

      if (typeof result === 'string') return result;
      if (result !== null && typeof result === 'object') {
        const signature = (result as { signature?: unknown }).signature;
        if (typeof signature === 'string') return signature;
      }
      throw new Error('Phoenix wallet did not return a transaction signature');
    };
  }, [wallet.signAndSendTransaction]);

  const readiness = useMemo(() => getPhoenixExecutionReadiness({
    connected: wallet.connected,
    address: wallet.address,
    source: wallet.source,
    isPreparing: wallet.isPreparing,
    signAndSendTransaction: phoenixSignAndSendTransaction,
  }), [
    wallet.connected,
    wallet.address,
    wallet.source,
    wallet.isPreparing,
    phoenixSignAndSendTransaction,
  ]);

  const displayedPrice = scrubPrice ?? latestPrice ?? market?.markPrice ?? null;
  const change24h = market?.change24h ?? null;
  const isUp = (change24h ?? 0) >= 0;
  const pendingPositionActionById = useMemo(() => {
    const rows = new Map<string, PendingDetailPositionAction>();
    pendingPositionActions.forEach((action) => rows.set(action.positionId, action));
    return rows;
  }, [pendingPositionActions]);

  const loadMarket = useCallback(async () => {
    setLoadingMarket(true);
    setMarketError(null);
    try {
      setMarket(await fetchPhoenixMarket(symbol));
    } catch (err) {
      setMarketError(err instanceof Error ? err.message : 'Phoenix market unavailable');
    } finally {
      setLoadingMarket(false);
    }
  }, [symbol]);

  useEffect(() => {
    void loadMarket();
  }, [loadMarket]);

  const loadPositions = useCallback(async () => {
    if (!wallet.address) {
      setPositions([]);
      return;
    }

    setPositionsLoading(true);
    try {
      const state = await fetchPhoenixTraderState(wallet.address);
      setPositions(normalizePhoenixPositions(state));
    } catch (err) {
      setPositions([]);
      setPositionActionMessage(err instanceof Error ? err.message : 'Phoenix positions unavailable.');
    } finally {
      setPositionsLoading(false);
    }
  }, [wallet.address]);

  useEffect(() => {
    if (wallet.connected && wallet.address) {
      void loadPositions();
      return;
    }

    setPositions([]);
  }, [wallet.connected, wallet.address, loadPositions]);

  useEffect(() => {
    if (pendingPositionActions.length === 0 && pendingOrderPlacements.length === 0) return undefined;

    const interval = setInterval(() => {
      const cutoff = Date.now() - 60_000;
      setPendingPositionActions((current) => current.filter((action) => action.createdAt >= cutoff));
      setPendingOrderPlacements((current) => current.filter((action) => action.createdAt >= cutoff));
    }, 10_000);

    return () => clearInterval(interval);
  }, [pendingPositionActions.length, pendingOrderPlacements.length]);

  const amountValue = useMemo(() => {
    const value = Number.parseFloat(amountText);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }, [amountText]);

  const amountUsdc = useMemo(() => {
    if (amountMode === 'usd') return amountValue;
    return displayedPrice && displayedPrice > 0 ? amountValue * displayedPrice : 0;
  }, [amountMode, amountValue, displayedPrice]);

  const amountBase = useMemo(() => {
    if (amountMode === 'base') return amountValue;
    return displayedPrice && displayedPrice > 0 ? amountValue / displayedPrice : 0;
  }, [amountMode, amountValue, displayedPrice]);

  const estimatedFee = amountUsdc > 0 ? amountUsdc * (market?.fees.takerFee ?? 0) : 0;

  const handleScrub = useCallback((price: number | null, _time: number | null) => {
    setScrubPrice(price);
  }, []);

  const handleLatestPrice = useCallback((price: number | null) => {
    setLatestPrice(price);
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!wallet.address || !market || amountUsdc <= 0 || amountBase <= 0) return;
    setTicketBusy(true);
    setTicketMessage(null);
    try {
      const context: PhoenixExecutionContext = {
        wallet: readiness.wallet,
        connection: wallet.connection as PhoenixExecutionContext['connection'],
        signAndSendTransaction: phoenixSignAndSendTransaction,
      };

      const result = await placePhoenixOrder({
        venueId: 'phoenix',
        authority: wallet.address,
        symbol: market.venueSymbol,
        side,
        orderType,
        amountMode: 'base',
        amount: formatBaseQuantity(amountBase),
        limitPrice: orderType === 'limit' ? limitPriceText : undefined,
        slippageBps: 50,
      }, context);

      setTicketMessage(result.error?.message ?? (result.txSignature ? `Submitted: ${shortKey(result.txSignature)}` : 'Phoenix order submitted.'));
      if (result.status !== 'failed') {
        const signature = result.txSignature;
        if (signature) {
          setPendingOrderPlacements((current) => [
            {
              id: `order-${signature}`,
              side,
              orderType,
              amountBase,
              amountUsdc,
              signature,
              createdAt: Date.now(),
            },
            ...current,
          ].slice(0, 4));
        }
        setAmountText('');
        void loadPositions();
      }
    } catch (err) {
      setTicketMessage(err instanceof Error ? err.message : 'Phoenix order failed.');
    } finally {
      setTicketBusy(false);
    }
  }, [
    wallet.address,
    wallet.connection,
    market,
    amountUsdc,
    amountBase,
    side,
    orderType,
    limitPriceText,
    readiness.wallet,
    phoenixSignAndSendTransaction,
    loadPositions,
  ]);

  const handleClosePosition = useCallback(async (position: PhoenixPositionRow) => {
    if (!wallet.address) {
      setPositionActionMessage('Connect a Solana wallet before closing a Phoenix position.');
      return;
    }
    if (!wallet.connection || !phoenixSignAndSendTransaction) {
      setPositionActionMessage('Phoenix close needs a Solana wallet that can sign and send transactions.');
      return;
    }

    setClosingPositionId(position.id);
    setPositionActionMessage(null);
    try {
      const builtTransaction = await buildPhoenixMarketOrder({
        authority: wallet.address,
        symbol: position.symbol,
        side: position.side === 'long' ? 'short' : 'long',
        quantity: formatBaseQuantity(position.size),
        isReduceOnly: true,
        pdaIndex: position.traderPdaIndex,
        traderSubaccountIndex: position.traderSubaccountIndex,
      });
      const signature = await sendPhoenixBuiltTransaction({
        builtTransaction,
        connection: wallet.connection,
        walletAddress: wallet.address,
        signAndSendTransaction: phoenixSignAndSendTransaction,
      });
      setPendingPositionActions((current) => [
        ...current,
        {
          id: `close-${position.id}-${signature}`,
          kind: 'close_position',
          positionId: position.id,
          signature,
          createdAt: Date.now(),
        },
      ]);

      setPositionActionMessage(`Close submitted: ${shortKey(signature)}`);
      void loadPositions();
    } catch (err) {
      setPositionActionMessage(err instanceof Error ? err.message : 'Phoenix close failed.');
    } finally {
      setClosingPositionId(null);
    }
  }, [
    wallet.address,
    wallet.connection,
    phoenixSignAndSendTransaction,
    loadPositions,
  ]);

  const openTpslModal = useCallback((position: PhoenixPositionRow) => {
    setTpslModalPosition(position);
    setTpslModalTp(position.takeProfitPrice ? String(position.takeProfitPrice) : '');
    setTpslModalSl(position.stopLossPrice ? String(position.stopLossPrice) : '');
    setTpslModalMessage('');
  }, []);

  const handleSetPositionTpsl = useCallback(async () => {
    if (!tpslModalPosition) return;

    const nextTpPrice = tpslModalTp.trim();
    const nextSlPrice = tpslModalSl.trim();
    const tpValue = nextTpPrice ? Number.parseFloat(nextTpPrice) : null;
    const slValue = nextSlPrice ? Number.parseFloat(nextSlPrice) : null;

    if (tpValue === null && slValue === null) {
      setTpslModalMessage('Enter a TP or SL price.');
      return;
    }
    if ((tpValue !== null && (!Number.isFinite(tpValue) || tpValue <= 0))
      || (slValue !== null && (!Number.isFinite(slValue) || slValue <= 0))) {
      setTpslModalMessage('TP/SL prices must be greater than zero.');
      return;
    }
    if (!wallet.address || !wallet.connection) {
      setTpslModalMessage('Phoenix TP/SL requires a connected Solana wallet.');
      return;
    }
    if (!phoenixSignAndSendTransaction) {
      setTpslModalMessage('This wallet cannot send Phoenix Solana transactions from the app.');
      return;
    }

    setTpslModalBusy(true);
    setTpslModalMessage('');
    try {
      const builtTransaction = await buildPhoenixPositionConditionalOrder({
        authority: wallet.address,
        symbol: tpslModalPosition.symbol,
        positionSide: tpslModalPosition.side,
        takeProfitPrice: tpValue === null ? undefined : nextTpPrice,
        stopLossPrice: slValue === null ? undefined : nextSlPrice,
        pdaIndex: tpslModalPosition.traderPdaIndex,
        traderSubaccountIndex: tpslModalPosition.traderSubaccountIndex,
        baseUnits: String(tpslModalPosition.size),
      });
      const signature = await sendPhoenixBuiltTransaction({
        builtTransaction,
        connection: wallet.connection,
        walletAddress: wallet.address,
        signAndSendTransaction: phoenixSignAndSendTransaction,
      });
      setPendingPositionActions((current) => [
        ...current,
        {
          id: `tpsl-${tpslModalPosition.id}-${signature}`,
          kind: 'set_tpsl',
          positionId: tpslModalPosition.id,
          signature,
          takeProfitPrice: tpValue === null ? undefined : tpValue,
          stopLossPrice: slValue === null ? undefined : slValue,
          createdAt: Date.now(),
        },
      ]);
      setPositionActionMessage(`TP/SL submitted: ${shortKey(signature)}`);
      setTpslModalPosition(null);
      setTpslModalTp('');
      setTpslModalSl('');
      void loadPositions();
    } catch (err) {
      console.error('[phoenix][tpsl][market-detail]', {
        symbol: tpslModalPosition.symbol,
        side: tpslModalPosition.side,
        takeProfitPrice: tpValue === null ? null : nextTpPrice,
        stopLossPrice: slValue === null ? null : nextSlPrice,
        traderPdaIndex: tpslModalPosition.traderPdaIndex,
        traderSubaccountIndex: tpslModalPosition.traderSubaccountIndex,
        walletAddress: wallet.address,
      }, err);
      setTpslModalMessage(err instanceof Error ? err.message : 'Phoenix TP/SL failed.');
    } finally {
      setTpslModalBusy(false);
    }
  }, [
    tpslModalPosition,
    tpslModalTp,
    tpslModalSl,
    wallet.address,
    wallet.connection,
    phoenixSignAndSendTransaction,
    loadPositions,
  ]);

  const handleClearPositionTpsl = useCallback(async (
    position: PhoenixPositionRow,
    kind: 'take_profit' | 'stop_loss',
  ) => {
    const cancelParams = kind === 'take_profit' ? position.takeProfitCancel : position.stopLossCancel;
    if (!cancelParams) {
      setPositionActionMessage('This TP/SL order cannot be cleared from this screen yet.');
      return;
    }
    if (!wallet.address || !wallet.connection) {
      setPositionActionMessage('Phoenix TP/SL clear requires a connected Solana wallet.');
      return;
    }
    if (!phoenixSignAndSendTransaction) {
      setPositionActionMessage('This wallet cannot send Phoenix Solana transactions from the app.');
      return;
    }

    setClearingTpslKey(`${position.id}-${kind}`);
    setPositionActionMessage(null);
    try {
      const builtTransaction = await buildPhoenixCancelConditionalOrder({
        authority: wallet.address,
        symbol: position.symbol,
        executionDirection: cancelParams.executionDirection,
        conditionalOrderIndex: cancelParams.conditionalOrderIndex,
        traderPdaIndex: position.traderPdaIndex,
        traderSubaccountIndex: position.traderSubaccountIndex,
      });
      const signature = await sendPhoenixBuiltTransaction({
        builtTransaction,
        connection: wallet.connection,
        walletAddress: wallet.address,
        signAndSendTransaction: phoenixSignAndSendTransaction,
      });
      setPendingPositionActions((current) => [
        ...current,
        {
          id: `clear-${position.id}-${kind}-${signature}`,
          kind: 'clear_tpsl',
          positionId: position.id,
          clearKind: kind,
          signature,
          createdAt: Date.now(),
        },
      ]);
      setPositionActionMessage(`TP/SL clear submitted: ${shortKey(signature)}`);
      void loadPositions();
    } catch (err) {
      setPositionActionMessage(err instanceof Error ? err.message : 'Phoenix TP/SL clear failed.');
    } finally {
      setClearingTpslKey(null);
    }
  }, [loadPositions, phoenixSignAndSendTransaction, wallet.address, wallet.connection]);

  const primaryButton = useMemo(() => {
    if (!wallet.connected) {
      return {
        label: 'Connect wallet',
        disabled: false,
        onPress: () => connectSheet.open('solana'),
      };
    }
    if (!readiness.wallet.canSignAndSendTransaction) {
      return {
        label: 'Solana TX Wallet Required',
        disabled: true,
        onPress: undefined,
      };
    }
    if (!market?.tradeable) {
      return {
        label: 'Market Not Active',
        disabled: true,
        onPress: undefined,
      };
    }
    if (amountUsdc <= 0) {
      return {
        label: `Hold to ${side === 'long' ? 'Long' : 'Short'}`,
        disabled: true,
        onPress: undefined,
      };
    }
    if (amountBase <= 0) {
      return {
        label: 'Price Required',
        disabled: true,
        onPress: undefined,
      };
    }
    if (orderType === 'limit' && !limitPriceText.trim()) {
      return {
        label: 'Enter Limit Price',
        disabled: true,
        onPress: undefined,
      };
    }
    return {
      label: `${orderType === 'limit' ? 'Limit ' : ''}${side === 'long' ? 'Long' : 'Short'} $${amountUsdc.toFixed(0)}`,
      disabled: false,
      onPress: handleSubmit,
    };
  }, [
    wallet,
    connectSheet.open,
    readiness.wallet.canSignAndSendTransaction,
    market?.tradeable,
    amountUsdc,
    amountBase,
    side,
    orderType,
    limitPriceText,
    handleSubmit,
  ]);

  return (
    <>
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <AppTopBar
        left={(
          <Pressable
            style={({ pressed }) => [styles.backBtn, pressed && styles.backBtnPressed]}
            onPress={() => router.back()}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <MaterialIcons name="arrow-back-ios" size={14} color={semantic.text.primary} />
            <Text style={styles.detailSym}>{market?.symbol ?? symbol}</Text>
          </Pressable>
        )}
        center={(
          <View style={styles.headerPriceCenter}>
            <Text style={styles.headerPrice}>{formatPhoenixPrice(displayedPrice)}</Text>
            {scrubPrice === null && (
              <Text style={[styles.headerChange, isUp ? styles.textPos : styles.textNeg]}>
                {formatPhoenixPercent(change24h)}
              </Text>
            )}
          </View>
        )}
        right={(
          <Pressable onPress={() => router.push('/markets/phoenix/profile')} style={styles.avatarRing}>
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
      ) : market ? (
        <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
          <PhoenixPriceChart
            symbol={market.symbol}
            showBitcoinDemo={isBitcoinPerpSymbol(symbol)
              || isBitcoinPerpSymbol(market.symbol)
              || market.baseSymbol.trim().toUpperCase() === 'BTC'}
            height={140}
            onScrub={handleScrub}
            onLatestPrice={handleLatestPrice}
          />

          <View style={styles.statsStrip}>
            <StatBox label="Mark" value={formatPhoenixPrice(displayedPrice)} />
            <StatBox label="Fund/1h" value={formatPhoenixRate(market.fundingRate)} tone={(market.fundingRate ?? 0) >= 0 ? 'pos' : 'neg'} />
            <StatBox label="OI" value={formatUsdCompact(market.openInterest)} />
            <StatBox label="24h Vol" value={formatUsdCompact(market.volume24h)} />
          </View>

          {!wallet.connected ? (
            <View style={styles.disconnectedCta}>
              <MaterialIcons name="lock" size={32} color={semantic.text.dim} />
              <Text style={styles.disconnectedText}>
                Connect your wallet to trade {market.baseSymbol} perpetuals
              </Text>
              <Pressable style={styles.connectWalletBtn} onPress={() => connectSheet.open('solana')}>
                <Text style={styles.connectWalletText}>Connect wallet</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.orderSection}>

            <View style={styles.sideToggle}>
              <Pressable
                style={[styles.sideBtn, side === 'long' && styles.sideBtnLongActive]}
                onPress={() => setSide('long')}
              >
                <Text style={[styles.sideBtnText, side === 'long' && styles.textPos]}>Long</Text>
              </Pressable>
              <Pressable
                style={[styles.sideBtn, side === 'short' && styles.sideBtnShortActive]}
                onPress={() => setSide('short')}
              >
                <Text style={[styles.sideBtnText, side === 'short' && styles.textNeg]}>Short</Text>
              </Pressable>
            </View>

            <View style={styles.orderTypeRow}>
              <SegmentButton label="Market" active={orderType === 'market'} onPress={() => setOrderType('market')} />
              <SegmentButton
                label="Limit"
                active={orderType === 'limit'}
                onPress={() => {
                  setOrderType('limit');
                  if (!limitPriceText && displayedPrice) setLimitPriceText(displayedPrice.toFixed(2));
                }}
              />
            </View>

            {orderType === 'limit' && (
              <View style={styles.limitPriceSection}>
                <Text style={styles.amountLabel}>Limit Price (USD)</Text>
                <View style={styles.limitPriceRow}>
                  <Text style={styles.inputPrefix}>$</Text>
                  <TextInput
                    style={styles.limitPriceInput}
                    value={limitPriceText}
                    onChangeText={(value) => setLimitPriceText(value.replace(/[^0-9.]/g, ''))}
                    keyboardType="decimal-pad"
                    placeholder={displayedPrice ? displayedPrice.toFixed(2) : '0'}
                    placeholderTextColor={semantic.text.faint}
                  />
                </View>
              </View>
            )}

            <View style={styles.amountSection}>
              <Pressable onPress={() => setAmountMode(amountMode === 'usd' ? 'base' : 'usd')}>
                <Text style={styles.amountLabel}>
                  {amountMode === 'usd' ? 'Amount (USDC)' : `Amount (${market.baseSymbol})`}
                  {'  '}
                  <Text style={styles.amountToggleHint}>tap to switch</Text>
                </Text>
              </Pressable>
              <View style={styles.amountRow}>
                {amountMode === 'usd' && <Text style={styles.inputPrefix}>$</Text>}
                <TextInput
                  style={styles.amountInput}
                  value={amountText}
                  onChangeText={(value) => setAmountText(value.replace(/[^0-9.]/g, ''))}
                  keyboardType="decimal-pad"
                  placeholder="0"
                  placeholderTextColor={semantic.text.faint}
                />
                {amountMode === 'base' && <Text style={styles.inputSuffix}>{market.baseSymbol}</Text>}
              </View>
              {amountUsdc > 0 && (
                <Text style={styles.amountSecondary}>
                  {amountMode === 'usd'
                    ? `~ ${amountBase.toFixed(4)} ${market.baseSymbol}`
                    : `~ $${amountUsdc.toFixed(2)}`}
                </Text>
              )}
            </View>

            <View style={styles.leverageRow}>
              <Text style={styles.availText}>$-- balance</Text>
              {readiness.wallet.canSignAndSendTransaction ? (
                <Text style={styles.leverageText}>Phoenix ready</Text>
              ) : (
                <Text style={[styles.leverageText, styles.textNeg]}>TX wallet needed</Text>
              )}
              <Text style={styles.availText}>max {market.maxLeverage ?? '--'}x</Text>
            </View>

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
                        onChangeText={(value) => setTpPriceText(value.replace(/[^0-9.]/g, ''))}
                        placeholder="--"
                        placeholderTextColor={semantic.text.faint}
                        keyboardType="decimal-pad"
                      />
                    </View>
                    <View style={styles.tpslField}>
                      <Text style={[styles.tpslFieldLabel, styles.textNeg]}>SL Price</Text>
                      <TextInput
                        style={[styles.tpslInput, styles.tpslInputSl]}
                        value={slPriceText}
                        onChangeText={(value) => setSlPriceText(value.replace(/[^0-9.]/g, ''))}
                        placeholder="--"
                        placeholderTextColor={semantic.text.faint}
                        keyboardType="decimal-pad"
                      />
                    </View>
                  </View>
                )}
              </View>
            )}

            <View style={styles.orderSummary}>
              <SummaryItem label="Size" value={amountUsdc > 0 ? `$${amountUsdc.toFixed(0)}` : '--'} sub={amountBase > 0 ? `${amountBase.toFixed(4)} ${market.baseSymbol}` : undefined} />
              <SummaryItem label="Est. Fee" value={estimatedFee > 0 ? `$${estimatedFee.toFixed(3)}` : '--'} />
              <SummaryItem label="Liq. Price" value="--" align="right" tone="neg" />
            </View>

            <Pressable
              style={[
                styles.submitBtn,
                side === 'long' ? styles.submitLong : styles.submitShort,
                primaryButton.disabled && styles.submitDisabled,
              ]}
              disabled={primaryButton.disabled || ticketBusy}
              onPress={primaryButton.onPress}
            >
              {ticketBusy ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.submitText} numberOfLines={1}>{primaryButton.label}</Text>
              )}
            </Pressable>

            {ticketMessage && (
              <Text style={styles.ticketMessage}>{ticketMessage}</Text>
            )}

            <View style={styles.myPositionsSection}>
              <Text style={styles.myPositionsTitle}>My Positions</Text>
              {pendingOrderPlacements.map((pendingOrder) => (
                <PendingOrderPlacementCard
                  key={pendingOrder.id}
                  symbol={market.symbol}
                  pendingOrder={pendingOrder}
                />
              ))}
              {positionsLoading ? (
                <ActivityIndicator size="small" color={semantic.text.accent} style={{ marginTop: 8 }} />
              ) : positions.length === 0 ? (
                <Text style={styles.myPositionsEmpty}>No open positions</Text>
              ) : (
                positions.map((position) => (
                  <PhoenixPositionCard
                    key={position.id}
                    position={position}
                    isClosing={closingPositionId === position.id}
                    clearingTpslKey={clearingTpslKey}
                    pendingAction={pendingPositionActionById.get(position.id) ?? null}
                    onPressTpsl={() => openTpslModal(position)}
                    onPressClose={() => void handleClosePosition(position)}
                    onPressClearTpsl={(kind) => void handleClearPositionTpsl(position, kind)}
                  />
                ))
              )}
              {positionActionMessage && (
                <Text style={styles.positionActionMessage}>{positionActionMessage}</Text>
              )}
            </View>
          </View>
          )}

          <View style={{ height: 24 }} />
        </ScrollView>
      ) : null}
    </View>
    <PhoenixTpslModal
      position={tpslModalPosition}
      tpValue={tpslModalTp}
      slValue={tpslModalSl}
      message={tpslModalMessage}
      busy={tpslModalBusy}
      onChangeTp={(value) => setTpslModalTp(value.replace(/[^0-9.]/g, ''))}
      onChangeSl={(value) => setTpslModalSl(value.replace(/[^0-9.]/g, ''))}
      onClose={() => {
        if (!tpslModalBusy) setTpslModalPosition(null);
      }}
      onSubmit={handleSetPositionTpsl}
    />

    <ConnectionSheet
      visible={connectSheet.visible}
      chain={connectSheet.chain}
      onClose={connectSheet.close}
    />
    </>
  );
}

function StatBox({ label, value, tone }: { label: string; value: string; tone?: 'pos' | 'neg' }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statVal, tone === 'pos' && styles.textPos, tone === 'neg' && styles.textNeg]}>
        {value}
      </Text>
    </View>
  );
}

function SegmentButton({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      style={[styles.orderTypePill, active && styles.orderTypePillActive]}
      onPress={onPress}
    >
      <Text style={[styles.orderTypePillText, active && styles.orderTypePillTextActive]}>
        {label}
      </Text>
    </Pressable>
  );
}

function SummaryItem({
  label,
  value,
  sub,
  align = 'left',
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  align?: 'left' | 'right';
  tone?: 'pos' | 'neg';
}) {
  return (
    <View style={[styles.summaryItem, align === 'right' && { alignItems: 'flex-end' }]}>
      <Text style={styles.sumLabel}>{label}</Text>
      <Text style={[styles.sumVal, tone === 'pos' && styles.textPos, tone === 'neg' && styles.textNeg]}>{value}</Text>
      {sub && <Text style={styles.sumSubVal}>{sub}</Text>}
    </View>
  );
}

function PhoenixPositionCard({
  position,
  isClosing,
  clearingTpslKey,
  pendingAction,
  onPressTpsl,
  onPressClose,
  onPressClearTpsl,
}: {
  position: PhoenixPositionRow;
  isClosing: boolean;
  clearingTpslKey: string | null;
  pendingAction: PendingDetailPositionAction | null;
  onPressTpsl: () => void;
  onPressClose: () => void;
  onPressClearTpsl: (kind: 'take_profit' | 'stop_loss') => void;
}) {
  const pnl = position.unrealizedPnl ?? 0;
  const pnlPositive = pnl >= 0;
  const displayTakeProfitPrice = pendingAction?.kind === 'clear_tpsl' && pendingAction.clearKind === 'take_profit'
    ? null
    : pendingAction?.kind === 'set_tpsl' && pendingAction.takeProfitPrice !== undefined
      ? pendingAction.takeProfitPrice
      : position.takeProfitPrice;
  const displayStopLossPrice = pendingAction?.kind === 'clear_tpsl' && pendingAction.clearKind === 'stop_loss'
    ? null
    : pendingAction?.kind === 'set_tpsl' && pendingAction.stopLossPrice !== undefined
      ? pendingAction.stopLossPrice
      : position.stopLossPrice;
  const hasTpsl = displayTakeProfitPrice !== null || displayStopLossPrice !== null;
  const clearingTakeProfit = clearingTpslKey === `${position.id}-take_profit`;
  const clearingStopLoss = clearingTpslKey === `${position.id}-stop_loss`;
  const pendingClose = pendingAction?.kind === 'close_position';
  const pendingLabel = pendingAction
    ? pendingAction.kind === 'close_position'
      ? 'Close pending'
      : pendingAction.kind === 'set_tpsl'
        ? 'TP/SL pending'
        : 'TP/SL clear pending'
    : null;

  return (
    <View style={[styles.posCard, pendingAction && styles.pendingPosCard]}>
      <View style={styles.posCardTop}>
        <View style={[styles.posSideBadge, position.side === 'long' ? styles.posSideLong : styles.posSideShort]}>
          <Text style={[styles.posSideText, position.side === 'long' ? styles.textPos : styles.textNeg]}>
            {position.side.toUpperCase()}
          </Text>
        </View>
        <Text style={styles.posSymbol}>{position.symbol}</Text>
        <Text style={styles.posSize}>{formatBaseQuantity(position.size)}</Text>
        <Text style={[styles.posPnl, pnlPositive ? styles.textPos : styles.textNeg]}>
          {formatPhoenixSignedUsd(position.unrealizedPnl)}
        </Text>
      </View>
      {pendingAction && (
        <Text style={styles.pendingPositionText}>{pendingLabel} {shortKey(pendingAction.signature)}</Text>
      )}
      <View style={styles.posCardMeta}>
        <Text style={styles.posMetaText}>Entry {formatPhoenixPrice(position.entryPrice)}</Text>
        <Text style={styles.posMetaText}>Mark {formatPhoenixPrice(position.markPrice)}</Text>
        {displayTakeProfitPrice !== null && (
          <Pressable
            style={styles.posTpslChip}
            onPress={() => onPressClearTpsl('take_profit')}
            disabled={!position.takeProfitCancel || clearingTakeProfit || !!pendingAction}
            accessibilityRole="button"
            accessibilityLabel={`Clear ${position.symbol} take profit`}
          >
            <Text style={[styles.posMetaText, styles.textPos]}>TP {formatPhoenixPrice(displayTakeProfitPrice)}</Text>
            <MaterialIcons name="close" size={10} color={tokens.colors.vermillion} />
          </Pressable>
        )}
        {displayStopLossPrice !== null && (
          <Pressable
            style={styles.posTpslChip}
            onPress={() => onPressClearTpsl('stop_loss')}
            disabled={!position.stopLossCancel || clearingStopLoss || !!pendingAction}
            accessibilityRole="button"
            accessibilityLabel={`Clear ${position.symbol} stop loss`}
          >
            <Text style={[styles.posMetaText, styles.textNeg]}>SL {formatPhoenixPrice(displayStopLossPrice)}</Text>
            <MaterialIcons name="close" size={10} color={tokens.colors.vermillion} />
          </Pressable>
        )}
      </View>
      <View style={styles.posCardActions}>
        <Pressable style={[styles.posActionBtn, pendingClose && styles.submitDisabled]} onPress={onPressTpsl} disabled={pendingClose}>
          <Text style={styles.posActionBtnText}>
            {pendingAction?.kind === 'set_tpsl' ? 'TP/SL Pending' : hasTpsl ? 'Edit TP/SL' : 'TP/SL'}
          </Text>
        </Pressable>
        <Pressable style={[styles.posActionBtn, styles.posActionBtnClose, pendingClose && styles.submitDisabled]} onPress={onPressClose} disabled={isClosing || pendingClose}>
          <Text style={[styles.posActionBtnText, styles.textNeg]}>{isClosing ? 'Closing...' : pendingClose ? 'Close Pending' : 'Close'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function PendingOrderPlacementCard({
  symbol,
  pendingOrder,
}: {
  symbol: string;
  pendingOrder: PendingDetailOrderPlacement;
}) {
  return (
    <View style={[styles.posCard, styles.pendingPosCard]}>
      <View style={styles.posCardTop}>
        <View style={[styles.posSideBadge, pendingOrder.side === 'long' ? styles.posSideLong : styles.posSideShort]}>
          <Text style={[styles.posSideText, pendingOrder.side === 'long' ? styles.textPos : styles.textNeg]}>
            {pendingOrder.side.toUpperCase()}
          </Text>
        </View>
        <Text style={styles.posSymbol}>{symbol}</Text>
        <Text style={styles.posSize}>{formatBaseQuantity(pendingOrder.amountBase)}</Text>
      </View>
      <Text style={styles.pendingPositionText}>
        {pendingOrder.orderType === 'limit' ? 'Limit order' : 'Market order'} pending {shortKey(pendingOrder.signature)}
      </Text>
      <View style={styles.posCardMeta}>
        <Text style={styles.posMetaText}>Size ${pendingOrder.amountUsdc.toFixed(2)}</Text>
        <Text style={styles.posMetaText}>Waiting for Phoenix state</Text>
      </View>
    </View>
  );
}

function PhoenixTpslModal({
  position,
  tpValue,
  slValue,
  message,
  busy,
  onChangeTp,
  onChangeSl,
  onClose,
  onSubmit,
}: {
  position: PhoenixPositionRow | null;
  tpValue: string;
  slValue: string;
  message: string;
  busy: boolean;
  onChangeTp: (value: string) => void;
  onChangeSl: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void | Promise<void>;
}) {
  return (
    <Modal visible={position !== null} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalOverlay} onPress={onClose}>
        <Pressable style={styles.modalCard} onPress={() => {}}>
          <Text style={styles.modalTitle}>
            {position?.takeProfitPrice || position?.stopLossPrice ? 'Edit' : 'Set'} TP / SL - {position?.symbol} {position?.side.toUpperCase()}
          </Text>
          <View style={styles.tpslInputRow}>
            <View style={styles.tpslField}>
              <Text style={styles.tpslFieldLabel}>TP Price</Text>
              <TextInput
                style={styles.tpslInput}
                value={tpValue}
                onChangeText={onChangeTp}
                keyboardType="decimal-pad"
                placeholder="--"
                placeholderTextColor={semantic.text.faint}
              />
            </View>
            <View style={styles.tpslField}>
              <Text style={[styles.tpslFieldLabel, styles.textNeg]}>SL Price</Text>
              <TextInput
                style={[styles.tpslInput, styles.tpslInputSl]}
                value={slValue}
                onChangeText={onChangeSl}
                keyboardType="decimal-pad"
                placeholder="--"
                placeholderTextColor={semantic.text.faint}
              />
            </View>
          </View>
          {message ? <Text style={styles.tpslModalMsg}>{message}</Text> : null}
          <View style={styles.modalActionRow}>
            <Pressable style={styles.modalCancelBtn} onPress={onClose} disabled={busy}>
              <Text style={styles.modalCancelText}>Cancel</Text>
            </Pressable>
            <Pressable style={[styles.modalConfirmBtn, busy && styles.submitDisabled]} onPress={() => void onSubmit()} disabled={busy}>
              {busy ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.modalConfirmText}>Set TP/SL</Text>
              )}
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function shortKey(value: string): string {
  if (value.length <= 12) return value;
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function formatBaseQuantity(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  return value.toFixed(8).replace(/\.?0+$/, '');
}

function normalizePhoenixPositions(state: PhoenixTraderState | null): PhoenixPositionRow[] {
  const traders = (state?.traders ?? [])
    .map((item) => (item && typeof item === 'object' ? item as Record<string, unknown> : null))
    .filter((item): item is Record<string, unknown> => item !== null);
  const rows: PhoenixPositionRow[] = [];

  traders.forEach((trader, traderIndex) => {
    const rawPositions = Array.isArray(trader.positions) ? trader.positions : [];
    const traderPdaIndex = toNumber(trader.traderPdaIndex) ?? traderIndex;
    const traderSubaccountIndex = toNumber(trader.traderSubaccountIndex) ?? 0;
    rawPositions.forEach((item, positionIndex) => {
      const record = item && typeof item === 'object' ? item as Record<string, unknown> : null;
      if (!record) return;

      const rawSymbol = typeof record.symbol === 'string' ? record.symbol : null;
      const size = toNumber(record.positionSize) ?? 0;
      if (!rawSymbol || size === 0) return;

      rows.push({
        id: `${traderIndex}-${rawSymbol}-${positionIndex}`,
        symbol: rawSymbol,
        side: size >= 0 ? 'long' : 'short',
        size: Math.abs(size),
        entryPrice: toUsd(record.entryPrice),
        markPrice: toMarkPrice(record),
        liquidationPrice: toUsd(record.liquidationPrice),
        unrealizedPnl: toUsd(record.unrealizedPnl),
        notionalUsd: toUsd(record.positionValue),
        takeProfitPrice: toUsd(record.takeProfitPrice),
        stopLossPrice: toUsd(record.stopLossPrice),
        takeProfitCancel: conditionalCancelParams(record.conditionalTakeProfitTriggers),
        stopLossCancel: conditionalCancelParams(record.conditionalStopLossTriggers),
        traderPdaIndex,
        traderSubaccountIndex,
      });
    });
  });

  return rows.sort((a, b) => Math.abs(b.notionalUsd ?? 0) - Math.abs(a.notionalUsd ?? 0));
}

function conditionalCancelParams(value: unknown): PhoenixConditionalCancelParams | null {
  if (!Array.isArray(value)) return null;

  for (const item of value) {
    const record = item && typeof item === 'object' ? item as Record<string, unknown> : null;
    if (!record) continue;

    const status = typeof record.status === 'string' ? record.status.toLowerCase() : null;
    if (status && status !== 'active' && status !== 'open') continue;

    const directIndex = toNumber(record.conditionalOrderIndex ?? record.index);
    const directDirection = typeof record.executionDirection === 'string'
      ? record.executionDirection
      : typeof record.triggerDirection === 'string'
        ? record.triggerDirection
        : null;
    if (directIndex !== null && directDirection) {
      return { conditionalOrderIndex: directIndex, executionDirection: directDirection };
    }

    const id = typeof record.conditionalTakeProfitId === 'string'
      ? record.conditionalTakeProfitId
      : typeof record.conditionalStopLossId === 'string'
        ? record.conditionalStopLossId
        : null;
    const match = id?.match(/-(\d+)-(gt|lt)$/i);
    if (match) {
      return {
        conditionalOrderIndex: Number.parseInt(match[1], 10),
        executionDirection: match[2].toLowerCase(),
      };
    }
  }

  return null;
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value && typeof value === 'object' && 'ui' in value) {
    const parsed = Number((value as { ui?: unknown }).ui);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value && typeof value === 'object' && 'value' in value) {
    const record = value as { value?: unknown; decimals?: unknown };
    const raw = typeof record.value === 'number' ? record.value : typeof record.value === 'string' ? Number(record.value) : null;
    const decimals = typeof record.decimals === 'number' ? record.decimals : 0;
    if (raw !== null && Number.isFinite(raw)) return raw / 10 ** decimals;
  }
  return null;
}

function toUsd(value: unknown): number | null {
  const number = toNumber(value);
  if (number === null) return null;
  if (
    ((typeof value === 'string' && !value.includes('.')) || typeof value === 'number')
    && Math.abs(number) >= 1_000_000
  ) {
    return number / 1_000_000;
  }
  return number;
}

function toMarkPrice(record: Record<string, unknown>): number | null {
  const explicit = toUsd(record.markPrice ?? record.oraclePrice);
  if (explicit !== null) return explicit;
  const positionValue = toUsd(record.positionValue);
  const size = toNumber(record.positionSize);
  if (positionValue !== null && size !== null && size !== 0) return Math.abs(positionValue / size);
  return null;
}

function formatPhoenixSignedUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '--';
  const sign = value >= 0 ? '+' : '-';
  return `${sign}${formatPhoenixPrice(Math.abs(value))}`;
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: semantic.background.screen,
  },
  scroll: {
    flex: 1,
  },
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    opacity: 0.8,
    padding: tokens.spacing.xs,
  },
  backBtnPressed: {
    opacity: 1,
  },
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
    marginTop: tokens.spacing.xs,
    backgroundColor: semantic.text.accent,
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
    borderRadius: tokens.radius.xs,
  },
  retryText: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.sm,
    fontWeight: '700',
    textTransform: 'uppercase',
    color: semantic.background.screen,
  },
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
    fontSize: tokens.fontSize.sm,
    fontWeight: '600',
    color: semantic.text.primary,
  },
  disconnectedCta: {
    alignItems: 'center',
    gap: tokens.spacing.md,
    paddingHorizontal: tokens.spacing.xl,
    paddingVertical: tokens.spacing.xl,
  },
  disconnectedText: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.sm,
    lineHeight: 18,
    color: semantic.text.dim,
    textAlign: 'center',
  },
  connectWalletBtn: {
    backgroundColor: tokens.colors.viridian,
    paddingHorizontal: tokens.spacing.lg,
    paddingVertical: tokens.spacing.md,
    borderRadius: 10,
  },
  connectWalletText: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.sm,
    fontWeight: '800',
    color: semantic.background.screen,
    textTransform: 'uppercase',
  },
  orderSection: {
    padding: tokens.spacing.lg,
    gap: 14,
  },
  sideToggle: {
    flexDirection: 'row',
    backgroundColor: semantic.background.surfaceRaised,
    borderRadius: 10,
    padding: 3,
    gap: 3,
  },
  sideBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 9,
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
    color: semantic.text.dim,
    textTransform: 'uppercase',
  },
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
  inputPrefix: {
    fontFamily: 'monospace',
    fontSize: 22,
    fontWeight: '700',
    color: semantic.text.faint,
  },
  inputSuffix: {
    fontFamily: 'monospace',
    fontSize: 22,
    fontWeight: '700',
    color: semantic.text.faint,
    marginLeft: 4,
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
  amountSecondary: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xs,
    color: semantic.text.faint,
    letterSpacing: 0.5,
  },
  leverageRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 2,
  },
  availText: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xs,
    color: semantic.text.faint,
    letterSpacing: 0.5,
  },
  leverageText: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xs,
    fontWeight: '700',
    letterSpacing: 0.5,
    color: tokens.colors.viridian,
  },
  tpslSection: {
    borderWidth: 1,
    borderColor: semantic.border.muted,
    borderRadius: 8,
    overflow: 'hidden',
  },
  tpslHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
  },
  tpslHeaderText: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xs,
    fontWeight: '700',
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    color: semantic.text.dim,
  },
  tpslInputRow: {
    flexDirection: 'row',
    gap: tokens.spacing.sm,
    paddingHorizontal: tokens.spacing.md,
    paddingBottom: tokens.spacing.md,
  },
  tpslField: {
    flex: 1,
  },
  tpslFieldLabel: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs,
    color: semantic.text.faint,
    marginBottom: 4,
  },
  tpslInput: {
    borderWidth: 1,
    borderColor: semantic.border.muted,
    borderRadius: 8,
    paddingHorizontal: tokens.spacing.sm,
    paddingVertical: 8,
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.sm,
    color: semantic.text.primary,
  },
  tpslInputSl: {
    borderColor: 'rgba(217,83,79,0.28)',
  },
  orderSummary: {
    flexDirection: 'row',
    backgroundColor: semantic.background.surfaceRaised,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    padding: tokens.spacing.md,
  },
  summaryItem: {
    flex: 1,
  },
  sumLabel: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs,
    color: semantic.text.faint,
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  sumVal: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.sm,
    fontWeight: '700',
    color: semantic.text.primary,
  },
  sumSubVal: {
    marginTop: 3,
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs,
    color: semantic.text.faint,
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
  submitDisabled: {
    opacity: 0.48,
  },
  submitText: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.sm,
    fontWeight: '900',
    color: '#fff',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  ticketMessage: {
    marginTop: tokens.spacing.sm,
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xs,
    lineHeight: 16,
    color: semantic.text.dim,
    textAlign: 'center',
  },
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
  positionActionMessage: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs,
    color: semantic.text.dim,
    textAlign: 'center',
    lineHeight: 16,
  },
  posCard: {
    backgroundColor: semantic.background.surfaceRaised,
    borderRadius: tokens.radius.sm,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    gap: 6,
    padding: tokens.spacing.sm,
  },
  pendingPosCard: {
    borderColor: 'rgba(199,183,112,0.45)',
    backgroundColor: 'rgba(199,183,112,0.08)',
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
    flex: 1,
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xs,
    fontWeight: '700',
    color: semantic.text.primary,
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
  pendingPositionText: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs,
    fontWeight: '800',
    color: tokens.colors.primary,
    textTransform: 'uppercase',
  },
  posTpslChip: {
    minHeight: 18,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 5,
    borderRadius: tokens.radius.xs,
    borderWidth: 1,
    borderColor: 'rgba(217,83,79,0.18)',
    backgroundColor: 'rgba(217,83,79,0.05)',
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
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: tokens.spacing.lg,
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
  modalActionRow: {
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
  tpslModalMsg: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs,
    color: tokens.colors.vermillion,
    textAlign: 'center',
  },
  textPos: {
    color: tokens.colors.viridian,
  },
  textNeg: {
    color: tokens.colors.vermillion,
  },
});
