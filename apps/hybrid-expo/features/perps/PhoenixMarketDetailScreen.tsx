/**
 * Phoenix market detail — composed onto the shared MarketScreen (#651).
 *
 * Pure refactor: every hook, callback and execution path is the previous inline
 * screen's code, unchanged; the layout is now the shared frame and the inline
 * order form moved into the action sheet (until the issue-652 action panel
 * supplies its own internals). Position cards became venue-worded rows.
 */

import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'expo-router';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
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
  type PhoenixMarket,
  type PhoenixTraderState,
} from '@/features/perps/phoenix.api';
import {
  getPhoenixExecutionReadiness,
  placePhoenixOrder,
  sendPhoenixBuiltTransaction,
  type PhoenixExecutionContext,
} from '@/features/perps/phoenix.execution';
import {
  PhoenixPriceChart,
  type PhoenixSelectedStoryDisplay,
} from '@/features/perps/PhoenixPriceChart';
import {
  DEFAULT_PHOENIX_CHART_TIMEFRAME_INDEX,
  PHOENIX_CHART_TIMEFRAMES,
} from '@/features/perps/phoenix.chart-config';
import {
  applyPhoenixLiveMarketStats,
  type PhoenixLiveConnectionStatus,
  type PhoenixLiveMarketStats,
} from '@/features/perps/phoenix.live';
import { semantic, tokens } from '@/theme';
import { MarketScreen } from '@/features/markets/MarketScreen';
import type {
  MarketDetailViewModel,
  PositionRowVM,
  ValueTone,
} from '@/features/markets/detail-view-model';
import type { RsiPaneData } from '@/features/charts';

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

  const [market, setMarket] = useState<PhoenixMarket | null>(null);
  const [loadingMarket, setLoadingMarket] = useState(true);
  const [marketError, setMarketError] = useState<string | null>(null);
  const [latestPrice, setLatestPrice] = useState<number | null>(null);
  const [scrubPrice, setScrubPrice] = useState<number | null>(null);
  const [liveStatus, setLiveStatus] = useState<PhoenixLiveConnectionStatus>('connecting');
  const [timeframeIndex, setTimeframeIndex] = useState(DEFAULT_PHOENIX_CHART_TIMEFRAME_INDEX);
  const [storiesVisible, setStoriesVisible] = useState(true);
  // RSI pane inputs reported by PhoenixPriceChart (#656).
  const [rsiData, setRsiData] = useState<RsiPaneData>({ kind: 'loading' });
  const [selectedStoryDisplay, setSelectedStoryDisplay] = useState<PhoenixSelectedStoryDisplay | null>(null);
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

    try {
      const state = await fetchPhoenixTraderState(wallet.address);
      setPositions(normalizePhoenixPositions(state));
    } catch (err) {
      setPositions([]);
      setPositionActionMessage(err instanceof Error ? err.message : 'Phoenix positions unavailable.');
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

  const handleLiveMarketStats = useCallback((stats: PhoenixLiveMarketStats) => {
    setMarket((current) => current ? applyPhoenixLiveMarketStats(current, stats) : current);
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
    if (!readiness.wallet.canSignAndSendTransaction) {
      return {
        label: 'Solana TX Wallet Required',
        disabled: true,
        onPress: undefined as (() => void) | undefined,
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
      onPress: handleSubmit as (() => void) | undefined,
    };
  }, [
    readiness.wallet.canSignAndSendTransaction,
    market?.tradeable,
    amountUsdc,
    amountBase,
    side,
    orderType,
    limitPriceText,
    handleSubmit,
  ]);

  const positionRows = useMemo<PositionRowVM[]>(() => {
    const pendingRows = pendingOrderPlacements.map((pendingOrder) => ({
      id: `pending-${pendingOrder.id}`,
      title: `${pendingOrder.side === 'long' ? 'Long' : 'Short'} ${pendingOrder.orderType === 'limit' ? 'limit' : 'market'} order`,
      detail: `Pending ${shortKey(pendingOrder.signature)} · waiting for Phoenix state`,
      value: `$${pendingOrder.amountUsdc.toFixed(2)}`,
      tone: 'flat' as ValueTone,
    }));

    const rows = positions.map((position) => {
      const pendingAction = pendingPositionActionById.get(position.id) ?? null;
      const pendingSignal = pendingAction
        ? {
            label: pendingAction.kind === 'close_position'
              ? 'Close pending'
              : pendingAction.kind === 'set_tpsl'
                ? 'TP/SL pending'
                : 'TP/SL clear pending',
            signature: shortKey(pendingAction.signature),
          }
        : null;
      const detailBits = [
        `Size ${formatBaseQuantity(position.size)}`,
        position.entryPrice !== null ? `Entry ${formatPhoenixPrice(position.entryPrice)}` : null,
        position.markPrice !== null ? `Mark ${formatPhoenixPrice(position.markPrice)}` : null,
        pendingSignal ? `${pendingSignal.label} ${pendingSignal.signature}` : null,
        clearingTpslKey === `${position.id}-take_profit` || clearingTpslKey === `${position.id}-stop_loss`
          ? 'TP/SL clearing…'
          : null,
      ].filter((bit: string | null): bit is string => bit !== null).join(' · ');
      const actions: { label: string; onPress: () => void }[] = [];
      if (position.takeProfitCancel && !pendingAction) {
        actions.push({
          label: 'Clear TP',
          onPress: () => void handleClearPositionTpsl(position, 'take_profit'),
        });
      }
      if (position.stopLossCancel && !pendingAction) {
        actions.push({
          label: 'Clear SL',
          onPress: () => void handleClearPositionTpsl(position, 'stop_loss'),
        });
      }
      actions.push({ label: 'TP/SL', onPress: () => openTpslModal(position) });
      actions.push({
        label: closingPositionId === position.id ? 'Closing…' : 'Close',
        onPress: () => void handleClosePosition(position),
      });

      const pnl = position.unrealizedPnl ?? 0;
      return {
        id: position.id,
        title: `${position.side === 'long' ? 'Long' : 'Short'} ${position.symbol}`,
        detail: detailBits,
        value: formatPhoenixSignedUsd(position.unrealizedPnl),
        tone: (pnl >= 0 ? 'up' : 'down') as ValueTone,
        actions,
      };
    });

    return [...pendingRows, ...rows];
  }, [
    pendingOrderPlacements,
    positions,
    pendingPositionActionById,
    clearingTpslKey,
    closingPositionId,
    handleClearPositionTpsl,
    openTpslModal,
    handleClosePosition,
  ]);

  const chartBody = (
    <PhoenixPriceChart
      symbol={market?.symbol ?? symbol}
      timeframeIndex={timeframeIndex}
      onTimeframeIndexChange={setTimeframeIndex}
      storiesVisible={storiesVisible}
      onStoriesVisibleChange={setStoriesVisible}
      onSelectedStoryDisplayChange={setSelectedStoryDisplay}
      onScrub={handleScrub}
      onLatestPrice={handleLatestPrice}
      onLiveMarketStats={handleLiveMarketStats}
      onLiveStatusChange={setLiveStatus}
      onRsiData={setRsiData}
    />
  );

  const vm: MarketDetailViewModel = {
    topBar: {
      marketName: market?.symbol ?? symbol,
      venueBadge: 'Phoenix',
      onBack: () => router.back(),
      onInfoPress: () => router.push('/markets/phoenix/profile'),
    },
    priceRow: {
      price: displayedPrice !== null ? formatPhoenixPrice(displayedPrice) : '--',
      change: change24h !== null
        ? { text: formatPhoenixPercent(change24h), tone: (isUp ? 'up' : 'down') as ValueTone }
        : null,
      live: scrubPrice === null && liveStatus === 'live',
      secondaryStat: market
        ? { label: '24h Vol', value: formatUsdCompact(market.volume24h) }
        : null,
    },
    notice: marketError ? (
      <View style={styles.noticeCard}>
        <Text style={styles.noticeTitle}>Market unavailable</Text>
        <Text style={styles.noticeText}>{marketError}</Text>
        <Pressable style={styles.noticeRetryBtn} onPress={() => void loadMarket()}>
          <Text style={styles.noticeRetryText}>Retry</Text>
        </Pressable>
      </View>
    ) : null,
    range: {
      ranges: PHOENIX_CHART_TIMEFRAMES.map((candidate) => candidate.label),
      activeRange: PHOENIX_CHART_TIMEFRAMES[timeframeIndex]?.label
        ?? PHOENIX_CHART_TIMEFRAMES[0]?.label
        ?? '1h',
      onSelectRange: (label) => {
        const index = PHOENIX_CHART_TIMEFRAMES.findIndex((candidate) => candidate.label === label);
        if (index >= 0) setTimeframeIndex(index);
      },
      newsVisible: storiesVisible,
      onToggleNews: () => setStoriesVisible((current) => !current),
    },
    chartBody,
    rsi: rsiData,
    newsStories: storiesVisible && selectedStoryDisplay
      ? [{
          id: `story-${selectedStoryDisplay.id}`,
          label: selectedStoryDisplay.text,
          timeLabel: [selectedStoryDisplay.timeLabel, selectedStoryDisplay.counter]
            .filter((part) => part !== null && part !== '')
            .join(' · '),
          imageUrl: selectedStoryDisplay.imageUrl,
          fallbackText: '✦',
        }]
      : [],
    positionsTitle: 'My Positions',
    positionsMessage: positionActionMessage ?? undefined,
    positionRows,
    actionBar: !wallet.connected
      ? {
          connected: false,
          connectReason: `Connect your wallet to trade ${market?.baseSymbol ?? symbol} perpetuals`,
          onConnect: () => connectSheet.open('solana'),
          buttons: [
            { label: 'Long', variant: 'primary' as const },
            { label: 'Short', variant: 'secondary' as const },
          ],
        }
      : {
          connected: true,
          buttons: [
            { label: 'Long', variant: 'primary' as const, disabled: !market?.tradeable, onPress: () => setSide('long') },
            { label: 'Short', variant: 'secondary' as const, disabled: !market?.tradeable, onPress: () => setSide('short') },
          ],
        },
    actionSheet: (
      <View style={styles.orderSheet}>
        <View style={styles.sideToggle}>
          <Pressable
            style={[styles.sideBtn, side === 'long' && styles.sideBtnLongActive]}
            onPress={() => setSide('long')}
          >
            <Text style={[styles.sideBtnText, side === 'long' && styles.sideBtnTextLong]}>Long</Text>
          </Pressable>
          <Pressable
            style={[styles.sideBtn, side === 'short' && styles.sideBtnShortActive]}
            onPress={() => setSide('short')}
          >
            <Text style={[styles.sideBtnText, side === 'short' && styles.sideBtnTextShort]}>Short</Text>
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
              {amountMode === 'usd'
                ? 'Amount (USDC)'
                : `Amount (${market?.baseSymbol ?? symbol})`}
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
            {amountMode === 'base' && <Text style={styles.inputSuffix}>{market?.baseSymbol ?? symbol}</Text>}
          </View>
          {amountUsdc > 0 && (
            <Text style={styles.amountSecondary}>
              {amountMode === 'usd'
                ? `~ ${amountBase.toFixed(4)} ${market?.baseSymbol ?? symbol}`
                : `~ $${amountUsdc.toFixed(2)}`}
            </Text>
          )}
        </View>

        <View style={styles.leverageRow}>
          <Text style={styles.availText}>$-- balance</Text>
          {readiness.wallet.canSignAndSendTransaction ? (
            <Text style={styles.leverageText}>Phoenix ready</Text>
          ) : (
            <Text style={styles.leverageTextWarn}>TX wallet needed</Text>
          )}
          <Text style={styles.availText}>max {market?.maxLeverage ?? '--'}x</Text>
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
                  <Text style={[styles.tpslFieldLabel, styles.tpslFieldLabelSl]}>SL Price</Text>
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
          <SummaryItem
            label="Size"
            value={amountUsdc > 0 ? `$${amountUsdc.toFixed(0)}` : '--'}
            sub={amountBase > 0 ? `${amountBase.toFixed(4)} ${market?.baseSymbol ?? symbol}` : undefined}
          />
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
      </View>
    ),
  };

  return (
    <>
      <MarketScreen vm={vm} />
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
      <Text style={[styles.sumVal, tone === 'pos' && styles.sumValPos, tone === 'neg' && styles.sumValNeg]}>{value}</Text>
      {sub && <Text style={styles.sumSubVal}>{sub}</Text>}
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
              <Text style={styles.tpslFieldLabel}>SL Price</Text>
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
  // Inline notice (market fetch failed) — retry stays in place, rest works.
  noticeCard: {
    paddingHorizontal: tokens.spacing.lg,
    paddingVertical: tokens.spacing.md,
    gap: tokens.spacing.xs,
    alignItems: 'center',
  },
  noticeTitle: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.md,
    fontWeight: '700',
    color: semantic.text.primary,
  },
  noticeText: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.sm,
    color: semantic.text.dim,
    textAlign: 'center',
  },
  noticeRetryBtn: {
    marginTop: tokens.spacing.xs,
    backgroundColor: semantic.text.accent,
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
    borderRadius: tokens.radius.xs,
  },
  noticeRetryText: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.sm,
    fontWeight: '700',
    textTransform: 'uppercase',
    color: semantic.background.screen,
  },
  // Order sheet — the moved inline order form, token-clean.
  orderSheet: {
    gap: tokens.spacing.md,
    paddingBottom: tokens.spacing.sm,
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
    borderWidth: 1,
    borderColor: tokens.colors.viridian,
  },
  sideBtnShortActive: {
    borderWidth: 1,
    borderColor: tokens.colors.vermillion,
  },
  sideBtnText: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xs,
    fontWeight: '700',
    letterSpacing: 1.5,
    color: semantic.text.dim,
    textTransform: 'uppercase',
  },
  sideBtnTextLong: {
    color: tokens.colors.viridian,
  },
  sideBtnTextShort: {
    color: tokens.colors.vermillion,
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
    backgroundColor: 'transparent',
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
  leverageTextWarn: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xs,
    fontWeight: '700',
    letterSpacing: 0.5,
    color: tokens.colors.vermillion,
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
  tpslFieldLabelSl: {
    color: tokens.colors.vermillion,
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
    borderColor: tokens.colors.vermillion,
  },
  tpslModalMsg: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs,
    color: tokens.colors.vermillion,
    textAlign: 'center',
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
  sumValPos: {
    color: tokens.colors.viridian,
  },
  sumValNeg: {
    color: tokens.colors.vermillion,
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
  // TP/SL modal (unchanged behavior and look)
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
});
