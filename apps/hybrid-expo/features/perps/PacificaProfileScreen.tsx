import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useRouter } from 'expo-router';
import { Suspense, lazy, useEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useWallet } from '@/hooks/useWallet';
import { useConnectionSheet } from '@/features/wallet/components/useConnectionSheet';
import {
  fetchPerpsAccount,
  fetchPerpsPositions,
  fetchOpenOrders,
  formatPrice,
} from '@/features/perps/perps.public-api';
import {
  closePosition,
  setTPSL,
  removeTPSL,
  cancelOrder,
  cancelStopOrder,
} from '@/features/perps/perps.signed-api';
import type { PerpsAccount, PerpsPosition, PerpsOrder } from '@/features/perps/perps.types';
import { AppTopBar, AppTopBarIconButton, AppTopBarTitle } from '@/components/AppTopBar';
import { semantic, tokens } from '@/theme';

const LazyPacificaDepositModal = lazy(() =>
  import('@/features/perps/PacificaDepositModal').then((module) => ({ default: module.PacificaDepositModal })),
);
const LazyPacificaWithdrawModal = lazy(() =>
  import('@/features/perps/PacificaWithdrawModal').then((module) => ({ default: module.PacificaWithdrawModal })),
);

// C-15: Trade history stored in AsyncStorage
const TRADE_HISTORY_KEY = 'pnl:trade_history';

interface TradeRecord {
  id: string;
  symbol: string;
  side: 'long' | 'short';
  size: number;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  closedAt: number;
  type: 'market_close' | 'tp_trigger' | 'sl_trigger';
}

async function loadTradeHistory(): Promise<TradeRecord[]> {
  try {
    const raw = await AsyncStorage.getItem(TRADE_HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

async function saveTradeRecord(record: TradeRecord): Promise<void> {
  const existing = await loadTradeHistory();
  existing.unshift(record);
  // Keep last 100
  if (existing.length > 100) existing.length = 100;
  await AsyncStorage.setItem(TRADE_HISTORY_KEY, JSON.stringify(existing));
}

function truncate(addr: string, start = 6, end = 4): string {
  return `${addr.slice(0, start)}···${addr.slice(-end)}`;
}

type Tab = 'positions' | 'orders' | 'history';

function orderTypeLabel(type: string): string {
  if (type === 'take_profit_limit') return 'Take Profit';
  if (type === 'stop_loss_limit') return 'Stop Loss';
  if (type.includes('limit')) return 'Limit';
  if (type.includes('market')) return 'Market';
  return type;
}

interface PacificaProfileScreenProps {
  /** Optional override. Defaults to router back, matching the other profiles. */
  onBack?: () => void;
}

// C-14: Polling interval (30 seconds)
const POLL_INTERVAL = 30_000;

export function PacificaProfileScreen({ onBack }: PacificaProfileScreenProps) {
  const router = useRouter();
  const { connected, address, signMessage } = useWallet();
  const connectSheet = useConnectionSheet({ chain: 'solana', applicationLabel: 'Pacifica' });
  const [account, setAccount] = useState<PerpsAccount | null>(null);
  const [positions, setPositions] = useState<PerpsPosition[]>([]);
  const [orders, setOrders] = useState<PerpsOrder[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [accountChecked, setAccountChecked] = useState(false);
  const [depositOpen, setDepositOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [depositModalLoaded, setDepositModalLoaded] = useState(false);
  const [withdrawModalLoaded, setWithdrawModalLoaded] = useState(false);

  // C-15: Trade history
  const [tradeHistory, setTradeHistory] = useState<TradeRecord[]>([]);

  // Tabs (C-15: added history tab)
  const [activeTab, setActiveTab] = useState<Tab>('positions');

  // TP/SL modal
  const [tpslPosition, setTpslPosition] = useState<PerpsPosition | null>(null);
  const [tpPrice, setTpPrice] = useState('');
  const [slPrice, setSlPrice] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [actionMsg, setActionMsg] = useState('');

  // C-13: Partial close modal
  const [closePosition_, setClosePosition_] = useState<PerpsPosition | null>(null);
  const [closeAmountText, setCloseAmountText] = useState('');

  const hasPacificAccount = accountChecked && account !== null;
  const noPacificAccount = accountChecked && account === null;

  useEffect(() => {
    if (depositOpen) setDepositModalLoaded(true);
  }, [depositOpen]);

  useEffect(() => {
    if (withdrawOpen) setWithdrawModalLoaded(true);
  }, [withdrawOpen]);

  // Build a map: symbol → { tp, sl } from orders
  const tpslBySymbol = useMemo(() => {
    const map: Record<string, { tp?: PerpsOrder; sl?: PerpsOrder }> = {};
    for (const o of orders) {
      if (!map[o.symbol]) map[o.symbol] = {};
      if (o.orderType === 'take_profit_limit') map[o.symbol].tp = o;
      if (o.orderType === 'stop_loss_limit') map[o.symbol].sl = o;
    }
    return map;
  }, [orders]);

  // C-16: Total unrealized PnL
  const totalUnrealizedPnl = useMemo(() => {
    return positions.reduce((sum, pos) => sum + pos.unrealizedPnl, 0);
  }, [positions]);

  // C-16: Account leverage
  const accountLeverage = useMemo(() => {
    if (!account || account.equity <= 0) return 0;
    return account.totalMarginUsed / account.equity;
  }, [account]);

  const goToMarket = useCallback((symbol: string) => {
    router.push(`/markets/pacifica/${encodeURIComponent(symbol)}`);
  }, [router]);

  const fetchAll = useCallback((addr: string, mode: 'initial' | 'refresh' | 'silent' = 'initial') => {
    // Only show loading states on first load — polling and refresh update silently
    if (mode === 'initial') {
      setLoading(true);
      setAccountChecked(false);
    } else if (mode === 'refresh') {
      setRefreshing(true);
    }
    // 'silent' — no loading indicators, just swap data in

    Promise.all([
      fetchPerpsPositions(addr),
      fetchPerpsAccount(addr),
      fetchOpenOrders(addr),
    ])
      .then(([pos, acc, ord]) => {
        setPositions(pos);
        setAccount(acc);
        setOrders(ord);
      })
      .catch(() => {
        // Only blank data on initial load failure
        if (mode === 'initial') {
          setAccount(null);
          setPositions([]);
          setOrders([]);
        }
      })
      .finally(() => {
        setLoading(false);
        setRefreshing(false);
        setAccountChecked(true);
      });
  }, []);

  useEffect(() => {
    if (connected && address) {
      fetchAll(address, 'initial');
    } else {
      setAccount(null);
      setPositions([]);
      setOrders([]);
      setAccountChecked(false);
    }
  }, [connected, address, fetchAll]);

  // C-15: Load trade history
  useEffect(() => {
    loadTradeHistory().then(setTradeHistory);
  }, []);

  // C-14: Polling
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (connected && address) {
      pollRef.current = setInterval(() => {
        fetchAll(address, 'silent');
      }, POLL_INTERVAL);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [connected, address, fetchAll]);

  // C-14: Pull-to-refresh handler
  const onRefresh = useCallback(() => {
    if (!connected || !address) return;
    fetchAll(address, 'refresh');
  }, [connected, address, fetchAll]);

  // C-13: Close position (full or partial)
  const handleClosePosition = useCallback(async (pos: PerpsPosition, partialSize?: number) => {
    if (!address) return;
    setActionLoading(true);
    setActionMsg('');
    try {
      const closeSide = pos.side === 'long' ? 'ask' : 'bid';
      const sizeToClose = partialSize ?? pos.size;
      await closePosition(pos.symbol, closeSide, sizeToClose, address, signMessage);
      // C-15: Log trade to history
      await saveTradeRecord({
        id: `${pos.symbol}-${Date.now()}`,
        symbol: pos.symbol,
        side: pos.side,
        size: sizeToClose,
        entryPrice: pos.entryPrice,
        exitPrice: pos.markPrice,
        pnl: pos.unrealizedPnl * (sizeToClose / pos.size),
        closedAt: Date.now(),
        type: 'market_close',
      });
      loadTradeHistory().then(setTradeHistory);
      setClosePosition_(null);
      if (connected && address) fetchAll(address, 'silent');
    } catch (err: any) {
      setActionMsg(err.message ?? 'Close failed');
    } finally {
      setActionLoading(false);
    }
  }, [address, signMessage, connected, fetchAll]);

  const handleCancelOrder = useCallback(async (order: PerpsOrder) => {
    if (!address) return;
    setActionLoading(true);
    try {
      const isStop = order.orderType === 'take_profit_limit' || order.orderType === 'stop_loss_limit';
      if (isStop) {
        await cancelStopOrder(order.orderId, order.symbol, address, signMessage);
      } else {
        await cancelOrder(order.orderId, order.symbol, address, signMessage);
      }
      if (connected && address) fetchAll(address, 'silent');
    } catch (err: any) {
      setActionMsg(err.message ?? 'Cancel failed');
    } finally {
      setActionLoading(false);
    }
  }, [address, signMessage, connected, fetchAll]);

  // C-11: Pre-populate TP/SL modal
  const handleSetTPSL = useCallback(async () => {
    if (!address || !tpslPosition) return;
    setActionLoading(true);
    setActionMsg('');
    try {
      const side = tpslPosition.side === 'long' ? 'ask' : 'bid';
      const tpNum = parseFloat(tpPrice.trim());
      const slNum = parseFloat(slPrice.trim());
      const mark = tpslPosition.markPrice;
      const isLong = tpslPosition.side === 'long';

      if (!tpPrice.trim() && !slPrice.trim()) {
        setActionMsg('Set at least a take profit or stop loss price.');
        setActionLoading(false);
        return;
      }
      if (tpPrice.trim() && isLong && tpNum <= mark) {
        setActionMsg(`TP must be above mark ($${mark.toFixed(2)}) for a long.`);
        setActionLoading(false);
        return;
      }
      if (tpPrice.trim() && !isLong && tpNum >= mark) {
        setActionMsg(`TP must be below mark ($${mark.toFixed(2)}) for a short.`);
        setActionLoading(false);
        return;
      }
      if (slPrice.trim() && isLong && slNum >= mark) {
        setActionMsg(`SL must be below mark ($${mark.toFixed(2)}) for a long.`);
        setActionLoading(false);
        return;
      }
      if (slPrice.trim() && !isLong && slNum <= mark) {
        setActionMsg(`SL must be above mark ($${mark.toFixed(2)}) for a short.`);
        setActionLoading(false);
        return;
      }

      const tp = tpPrice.trim() ? { stopPrice: tpPrice.trim(), limitPrice: tpPrice.trim() } : undefined;
      const sl = slPrice.trim() ? { stopPrice: slPrice.trim(), limitPrice: slPrice.trim() } : undefined;
      await setTPSL({ symbol: tpslPosition.symbol, side, takeProfit: tp, stopLoss: sl }, address, signMessage);
      setTpslPosition(null);
      setTpPrice('');
      setSlPrice('');
      if (connected && address) fetchAll(address, 'silent');
    } catch (err: any) {
      setActionMsg(err.message ?? 'TP/SL failed');
    } finally {
      setActionLoading(false);
    }
  }, [address, signMessage, tpslPosition, tpPrice, slPrice, connected, fetchAll]);

  // C-11: Pre-populate on open
  const openTPSLModal = useCallback((pos: PerpsPosition) => {
    const existing = tpslBySymbol[pos.symbol];
    setTpPrice(existing?.tp?.stopPrice ? existing.tp.stopPrice.toString() : '');
    setSlPrice(existing?.sl?.stopPrice ? existing.sl.stopPrice.toString() : '');
    setActionMsg('');
    setTpslPosition(pos);
  }, [tpslBySymbol]);

  // C-12: Remove TP/SL
  const handleRemoveTPSL = useCallback(async (pos: PerpsPosition) => {
    if (!address) return;
    setActionLoading(true);
    setActionMsg('');
    try {
      const apiSide = pos.side === 'long' ? 'ask' : 'bid';
      await removeTPSL(pos.symbol, apiSide, 'both', address, signMessage, orders);
      setTpslPosition(null);
      if (connected && address) fetchAll(address, 'silent');
    } catch (err: any) {
      setActionMsg(err.message ?? 'Failed to remove TP/SL');
    } finally {
      setActionLoading(false);
    }
  }, [address, signMessage, orders, connected, fetchAll]);

  return (
    <View style={styles.container}>
      <AppTopBar
        left={<AppTopBarIconButton icon="arrow-back" onPress={onBack ?? (() => router.back())} accessibilityLabel="Go back" />}
        center={<AppTopBarTitle align="left">Profile</AppTopBarTitle>}
        right={hasPacificAccount ? (
          <View style={styles.headerActions}>
            <Pressable
              style={styles.headerActionBtn}
              onPress={() => setDepositOpen(true)}>
              <MaterialIcons name="arrow-downward" size={12} color={tokens.colors.viridian} />
              <Text style={[styles.headerActionText, { color: tokens.colors.viridian }]}>Deposit</Text>
            </Pressable>
            <Pressable
              style={styles.headerActionBtn}
              onPress={() => setWithdrawOpen(true)}>
              <MaterialIcons name="arrow-upward" size={12} color={tokens.colors.primary} />
              <Text style={styles.headerActionText}>Withdraw</Text>
            </Pressable>
          </View>
        ) : (
          <AppTopBarIconButton
            icon="settings"
            accessibilityLabel="Open trade settings"
            color={semantic.text.dim}
          />
        )}
      />

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.content}
        refreshControl={
          connected ? (
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={tokens.colors.primary}
            />
          ) : undefined
        }>

        {/* ── Identity section ──
            Hidden while disconnected. An empty avatar over "Not Connected"
            duplicates the connect prompt below it, and no other app's profile
            shows an identity row before there is an identity. */}
        {connected ? (
        <View style={styles.identity}>
          <View style={styles.avatarRing}>
            <View style={styles.avatarInner}>
              <MaterialIcons name="person" size={18} color={semantic.text.primary} />
            </View>
          </View>
          <View style={styles.identityInfo}>
            <Text style={styles.handle}>
              {address ? truncate(address) : 'Not Connected'}
            </Text>
            {connected && (
              <View style={styles.connectedChip}>
                <View style={styles.connectedDot} />
                <Text style={styles.connectedText}>Connected</Text>
              </View>
            )}
          </View>

          {loading ? (
            <ActivityIndicator size="small" color={semantic.text.accent} />
          ) : hasPacificAccount ? (
            <View style={styles.accountActiveBadge}>
              <View style={styles.connectedDot} />
              <Text style={styles.accountActiveText}>Pacifica</Text>
            </View>
          ) : noPacificAccount && connected ? (
            <View style={styles.noAccountBadge}>
              <MaterialIcons name="info-outline" size={12} color={tokens.colors.primary} />
              <Text style={styles.noAccountText}>No Account</Text>
            </View>
          ) : null}
        </View>
        ) : null}


        {/* ── Not connected ── */}
        {!connected && (
          <View style={styles.emptyState}>
            <MaterialIcons name="account-balance-wallet" size={28} color={semantic.text.faint} />
            <Text style={styles.emptyTitle}>Connect wallet</Text>
            <Text style={styles.emptyDesc}>
              Connect a wallet to view your Pacifica trading account.
            </Text>
            <Pressable style={styles.primaryBtn} onPress={() => { void connectSheet.open().catch(() => {}); }}>
              <Text style={styles.primaryBtnText}>Connect wallet</Text>
            </Pressable>
          </View>
        )}

        {/* ── Connected but no Pacifica account ── */}
        {noPacificAccount && connected && (
          <View style={styles.emptyState}>
            <MaterialIcons name="rocket-launch" size={28} color={semantic.text.faint} />
            <Text style={styles.emptyTitle}>No Pacifica Account</Text>
            <Text style={styles.emptyDesc}>
              Deposit USDC to create your Pacifica trading account and start trading perpetuals.
            </Text>
            <Pressable style={styles.primaryBtn} onPress={() => setDepositOpen(true)}>
              <Text style={styles.primaryBtnText}>Deposit to Start</Text>
            </Pressable>
          </View>
        )}

        {/* ── Has account: equity + tabs ── */}
        {hasPacificAccount && (
          <>
            {/* C-16: Enhanced equity card */}
            <View style={styles.equityCard}>
              <View style={styles.equityRow}>
                <View style={styles.eqItem}>
                  <Text style={styles.eqLabel}>Equity</Text>
                  <Text style={styles.eqVal}>${account.equity.toFixed(2)}</Text>
                </View>
                <View style={[styles.eqItem, styles.eqItemCenter]}>
                  <Text style={styles.eqLabel}>Margin Used</Text>
                  <Text style={styles.eqVal}>${account.totalMarginUsed.toFixed(2)}</Text>
                </View>
                <View style={[styles.eqItem, styles.eqItemRight]}>
                  <Text style={styles.eqLabel}>Available</Text>
                  <Text style={styles.eqVal}>${account.availableToSpend.toFixed(2)}</Text>
                </View>
              </View>
              {/* C-16: Extra row — unrealized PnL + account leverage */}
              <View style={styles.equityDivider} />
              <View style={styles.equityRow}>
                <View style={styles.eqItem}>
                  <Text style={styles.eqLabel}>Unrealized PnL</Text>
                  <Text style={[styles.eqVal, totalUnrealizedPnl >= 0 ? styles.textPos : styles.textNeg]}>
                    {totalUnrealizedPnl >= 0 ? '+' : ''}{totalUnrealizedPnl.toFixed(2)}
                  </Text>
                </View>
                <View style={[styles.eqItem, styles.eqItemCenter]}>
                  <Text style={styles.eqLabel}>Acct Leverage</Text>
                  <Text style={styles.eqVal}>{accountLeverage.toFixed(2)}x</Text>
                </View>
                <View style={[styles.eqItem, styles.eqItemRight]}>
                  <Text style={styles.eqLabel}>Positions</Text>
                  <Text style={styles.eqVal}>{positions.length}</Text>
                </View>
              </View>
            </View>

            {/* ── Tabs: Positions | Orders | History (C-15) ── */}
            <View style={styles.tabBar}>
              {(['positions', 'orders', 'history'] as Tab[]).map((tab) => {
                const count = tab === 'positions' ? positions.length : tab === 'orders' ? orders.length : tradeHistory.length;
                return (
                  <Pressable
                    key={tab}
                    style={[styles.tab, activeTab === tab && styles.tabActive]}
                    onPress={() => setActiveTab(tab)}>
                    <Text style={[styles.tabText, activeTab === tab && styles.tabTextActive]}>
                      {tab === 'positions' ? 'Positions' : tab === 'orders' ? 'Orders' : 'History'}
                    </Text>
                    {count > 0 && (
                      <View style={[styles.tabBadge, activeTab === tab && styles.tabBadgeActive]}>
                        <Text style={[styles.tabBadgeText, activeTab === tab && styles.tabBadgeTextActive]}>
                          {count}
                        </Text>
                      </View>
                    )}
                  </Pressable>
                );
              })}
            </View>

            {/* ── Positions tab ── */}
            {activeTab === 'positions' && (
              <View style={styles.tabContent}>
                {positions.length === 0 ? (
                  <View style={styles.posEmpty}>
                    <MaterialIcons name="inbox" size={22} color={semantic.text.faint} />
                    <Text style={styles.posEmptyText}>No open positions</Text>
                  </View>
                ) : (
                  positions.map((pos) => {
                    const isUp = pos.unrealizedPnl >= 0;
                    const tpsl = tpslBySymbol[pos.symbol];
                    const hasTpsl = !!(tpsl?.tp || tpsl?.sl);
                    return (
                      <View key={pos.symbol} style={styles.posCard}>
                        <Pressable
                          style={styles.posRow}
                          onPress={() => goToMarket(pos.symbol)}
                          accessibilityRole="button"
                          accessibilityLabel={`Open ${pos.symbol} market details`}
                          accessibilityHint="Navigates to the perps market detail screen">
                          <View style={styles.posLeft}>
                            <Text style={styles.posSym}>{pos.symbol}</Text>
                            <Text style={[styles.posSide, pos.side === 'long' ? styles.textPos : styles.textNeg]}>
                              {pos.side.toUpperCase()} · {pos.size}
                            </Text>
                            {/* TP/SL stacked */}
                            {(tpsl?.tp || tpsl?.sl) && (
                              <View style={styles.tpslStack}>
                                {tpsl.tp && (
                                  <View style={styles.tpslRow}>
                                    <Text style={styles.tpslLabelTP}>TP</Text>
                                    <Text style={styles.tpslValueTP}>{formatPrice(tpsl.tp.stopPrice!)}</Text>
                                  </View>
                                )}
                                {tpsl.sl && (
                                  <View style={styles.tpslRow}>
                                    <Text style={styles.tpslLabelSL}>SL</Text>
                                    <Text style={styles.tpslValueSL}>{formatPrice(tpsl.sl.stopPrice!)}</Text>
                                  </View>
                                )}
                              </View>
                            )}
                          </View>
                          <View style={styles.posRight}>
                            <Text style={styles.posEntry}>Entry {formatPrice(pos.entryPrice)}</Text>
                            <Text style={[styles.posPnl, isUp ? styles.textPos : styles.textNeg]}>
                              {isUp ? '+' : ''}{pos.unrealizedPnl.toFixed(2)} ({pos.unrealizedPnlPct.toFixed(1)}%)
                            </Text>
                          </View>
                        </Pressable>

                        {/* Inline action buttons */}
                        <View style={styles.posActionRow}>
                          <Pressable
                            style={styles.posActionBtn}
                            onPress={() => openTPSLModal(pos)}>
                            <MaterialIcons name="flag" size={12} color={tokens.colors.primary} />
                            <Text style={styles.posActionText}>{hasTpsl ? 'Edit TP/SL' : 'TP/SL'}</Text>
                          </Pressable>
                          {/* C-13: Partial close — opens modal */}
                          <Pressable
                            style={[styles.posActionBtn, styles.posActionBtnClose]}
                            onPress={() => {
                              setClosePosition_(pos);
                              setCloseAmountText(pos.size.toString());
                              setActionMsg('');
                            }}
                            disabled={actionLoading}>
                            <MaterialIcons name="close" size={12} color={tokens.colors.vermillion} />
                            <Text style={[styles.posActionText, { color: tokens.colors.vermillion }]}>Close</Text>
                          </Pressable>
                        </View>
                      </View>
                    );
                  })
                )}
              </View>
            )}

            {/* ── Orders tab ── */}
            {activeTab === 'orders' && (
              <View style={styles.tabContent}>
                {orders.length === 0 ? (
                  <View style={styles.posEmpty}>
                    <MaterialIcons name="receipt-long" size={22} color={semantic.text.faint} />
                    <Text style={styles.posEmptyText}>No open orders</Text>
                  </View>
                ) : (
                  orders.map((order) => {
                    const isTP = order.orderType === 'take_profit_limit';
                    const isSL = order.orderType === 'stop_loss_limit';
                    return (
                      <View key={order.orderId} style={styles.orderCard}>
                        <View style={styles.orderRow}>
                          <View style={styles.orderLeft}>
                            <View style={styles.orderTopRow}>
                              <Text style={styles.posSym}>{order.symbol}</Text>
                              <View style={[styles.orderTypeBadge, isTP ? styles.orderTypeBadgeTP : isSL ? styles.orderTypeBadgeSL : styles.orderTypeBadgeOther]}>
                                <Text style={[styles.orderTypeText, isTP ? styles.textPos : isSL ? styles.textNeg : { color: semantic.text.dim }]}>
                                  {orderTypeLabel(order.orderType)}
                                </Text>
                              </View>
                            </View>
                            <Text style={styles.orderDetail}>
                              {order.side === 'bid' ? 'Buy' : 'Sell'} · Trigger {formatPrice(order.stopPrice ?? order.price)}
                            </Text>
                            {order.reduceOnly && (
                              <Text style={styles.orderReduceOnly}>Reduce Only</Text>
                            )}
                          </View>
                          <Pressable
                            style={styles.cancelBtn}
                            onPress={() => handleCancelOrder(order)}
                            disabled={actionLoading}
                            hitSlop={6}>
                            <MaterialIcons name="close" size={14} color={tokens.colors.vermillion} />
                          </Pressable>
                        </View>
                      </View>
                    );
                  })
                )}
              </View>
            )}

            {/* ── C-15: History tab ── */}
            {activeTab === 'history' && (
              <View style={styles.tabContent}>
                {tradeHistory.length === 0 ? (
                  <View style={styles.posEmpty}>
                    <MaterialIcons name="history" size={22} color={semantic.text.faint} />
                    <Text style={styles.posEmptyText}>No trade history yet</Text>
                    <Text style={[styles.posEmptyText, { fontSize: tokens.fontSize.xxs - 1 }]}>
                      Closed positions will appear here
                    </Text>
                  </View>
                ) : (
                  tradeHistory.map((trade) => {
                    const isUp = trade.pnl >= 0;
                    return (
                      <View key={trade.id} style={styles.orderCard}>
                        <View style={styles.orderRow}>
                          <View style={styles.orderLeft}>
                            <View style={styles.orderTopRow}>
                              <Text style={styles.posSym}>{trade.symbol}</Text>
                              <View style={[styles.orderTypeBadge, trade.side === 'long' ? styles.orderTypeBadgeTP : styles.orderTypeBadgeSL]}>
                                <Text style={[styles.orderTypeText, trade.side === 'long' ? styles.textPos : styles.textNeg]}>
                                  {trade.side.toUpperCase()}
                                </Text>
                              </View>
                            </View>
                            <Text style={styles.orderDetail}>
                              {trade.size} · Entry {formatPrice(trade.entryPrice)} → {formatPrice(trade.exitPrice)}
                            </Text>
                            <Text style={styles.orderReduceOnly}>
                              {new Date(trade.closedAt).toLocaleDateString()} {new Date(trade.closedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </Text>
                          </View>
                          <Text style={[styles.posPnl, isUp ? styles.textPos : styles.textNeg]}>
                            {isUp ? '+' : ''}${trade.pnl.toFixed(2)}
                          </Text>
                        </View>
                      </View>
                    );
                  })
                )}
              </View>
            )}
          </>
        )}

        {/* Action message bar */}
        {actionMsg !== '' && (
          <View style={styles.actionMsgBar}>
            <Text style={styles.actionMsgText}>{actionMsg}</Text>
          </View>
        )}

        <View style={{ height: 120 }} />
      </ScrollView>

      {depositModalLoaded && (
        <Suspense fallback={null}>
          <LazyPacificaDepositModal
            visible={depositOpen}
            onClose={() => setDepositOpen(false)}
            onRequestConnect={() => { void connectSheet.open().catch(() => {}); }}
          />
        </Suspense>
      )}
      {withdrawModalLoaded && (
        <Suspense fallback={null}>
          <LazyPacificaWithdrawModal
            visible={withdrawOpen}
            onClose={() => setWithdrawOpen(false)}
            onRequestConnect={() => { void connectSheet.open().catch(() => {}); }}
          />
        </Suspense>
      )}

      {/* TP/SL Modal (C-11 pre-populated, C-12 remove button) */}
      <Modal
        visible={tpslPosition !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setTpslPosition(null)}>
        <Pressable style={styles.modalOverlay} onPress={() => setTpslPosition(null)}>
          <Pressable style={styles.modalCard} onPress={() => {}}>
            <Text style={styles.modalTitle}>
              {tpslBySymbol[tpslPosition?.symbol ?? '']?.tp || tpslBySymbol[tpslPosition?.symbol ?? '']?.sl ? 'Edit' : 'Set'} TP / SL — {tpslPosition?.symbol} {tpslPosition?.side.toUpperCase()}
            </Text>
            <Text style={styles.modalSubtitle}>
              Entry {tpslPosition ? formatPrice(tpslPosition.entryPrice) : ''} · Mark {tpslPosition ? formatPrice(tpslPosition.markPrice) : ''}
            </Text>

            <View style={styles.modalField}>
              <Text style={styles.modalLabel}>
                Take Profit {tpslPosition?.side === 'long' ? '(above mark)' : '(below mark)'}
              </Text>
              <TextInput
                style={styles.modalInput}
                value={tpPrice}
                onChangeText={setTpPrice}
                placeholder={tpslPosition?.side === 'long' ? `above ${tpslPosition.markPrice.toFixed(2)}` : `below ${tpslPosition?.markPrice.toFixed(2)}`}
                placeholderTextColor={semantic.text.faint}
                keyboardType="decimal-pad"
              />
            </View>

            <View style={styles.modalField}>
              <Text style={styles.modalLabel}>
                Stop Loss {tpslPosition?.side === 'long' ? '(below mark)' : '(above mark)'}
              </Text>
              <TextInput
                style={styles.modalInput}
                value={slPrice}
                onChangeText={setSlPrice}
                placeholder={tpslPosition?.side === 'long' ? `below ${tpslPosition.markPrice.toFixed(2)}` : `above ${tpslPosition?.markPrice.toFixed(2)}`}
                placeholderTextColor={semantic.text.faint}
                keyboardType="decimal-pad"
              />
            </View>

            {/* C-12: Remove button */}
            {tpslPosition && (tpslBySymbol[tpslPosition.symbol]?.tp || tpslBySymbol[tpslPosition.symbol]?.sl) && (
              <Pressable
                style={styles.removeTPSLBtn}
                onPress={() => handleRemoveTPSL(tpslPosition)}
                disabled={actionLoading}>
                <MaterialIcons name="delete-outline" size={14} color={tokens.colors.vermillion} />
                <Text style={styles.removeTPSLText}>Remove All TP/SL</Text>
              </Pressable>
            )}

            {actionMsg !== '' && (
              <Text style={styles.modalErrorText}>{actionMsg}</Text>
            )}

            <View style={styles.modalActions}>
              <Pressable style={styles.modalCancelBtn} onPress={() => setTpslPosition(null)}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.modalConfirmBtn, actionLoading && { opacity: 0.5 }]}
                onPress={handleSetTPSL}
                disabled={actionLoading}>
                <Text style={styles.modalConfirmText}>
                  {actionLoading ? 'Setting...' : 'Confirm'}
                </Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* C-13: Partial close modal */}
      <Modal
        visible={closePosition_ !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setClosePosition_(null)}>
        <Pressable style={styles.modalOverlay} onPress={() => setClosePosition_(null)}>
          <Pressable style={styles.modalCard} onPress={() => {}}>
            <Text style={styles.modalTitle}>
              Close {closePosition_?.symbol} {closePosition_?.side.toUpperCase()}
            </Text>
            <Text style={styles.modalSubtitle}>
              Size: {closePosition_?.size} · Entry {closePosition_ ? formatPrice(closePosition_.entryPrice) : ''}
            </Text>

            <View style={styles.modalField}>
              <Text style={styles.modalLabel}>Amount to Close</Text>
              <TextInput
                style={styles.modalInput}
                value={closeAmountText}
                onChangeText={(t) => setCloseAmountText(t.replace(/[^0-9.]/g, ''))}
                keyboardType="decimal-pad"
                selectTextOnFocus
              />
              <View style={styles.closeQuickRow}>
                {([25, 50, 75, 100] as const).map((pct) => (
                  <Pressable
                    key={pct}
                    style={styles.closeQuickPill}
                    onPress={() => {
                      if (closePosition_) {
                        setCloseAmountText(((closePosition_.size * pct) / 100).toString());
                      }
                    }}>
                    <Text style={styles.closeQuickPillText}>{pct === 100 ? 'Full' : `${pct}%`}</Text>
                  </Pressable>
                ))}
              </View>
            </View>

            {actionMsg !== '' && (
              <Text style={styles.modalErrorText}>{actionMsg}</Text>
            )}

            <View style={styles.modalActions}>
              <Pressable style={styles.modalCancelBtn} onPress={() => setClosePosition_(null)}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.modalConfirmBtn, actionLoading && { opacity: 0.5 }, { backgroundColor: tokens.colors.vermillion }]}
                onPress={() => {
                  if (closePosition_) {
                    const amt = parseFloat(closeAmountText);
                    if (!amt || amt <= 0) {
                      setActionMsg('Enter a valid amount');
                      return;
                    }
                    handleClosePosition(closePosition_, amt);
                  }
                }}
                disabled={actionLoading}>
                <Text style={styles.modalConfirmText}>
                  {actionLoading ? 'Closing...' : 'Close Position'}
                </Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },

  // Header
  // C-17: Header action buttons
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  headerActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: semantic.background.surfaceRaised,
    borderRadius: 12,
    paddingHorizontal: 8,
    minHeight: 26,
  },
  headerActionText: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs - 1,
    fontWeight: '700',
    letterSpacing: 0.8,
    color: tokens.colors.primary,
  },

  content: {
    padding: tokens.spacing.lg,
    gap: tokens.spacing.md,
  },

  // Identity
  identity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: tokens.spacing.md,
  },
  avatarRing: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1.5,
    borderColor: semantic.text.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInner: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: semantic.background.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  identityInfo: {
    flex: 1,
    gap: 3,
  },
  handle: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.sm,
    fontWeight: '700',
    color: semantic.text.primary,
    letterSpacing: 0.5,
  },
  connectedChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  connectedDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: tokens.colors.viridian,
  },
  connectedText: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs,
    color: tokens.colors.viridian,
    letterSpacing: 0.5,
  },
  accountActiveBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(74,140,111,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(74,140,111,0.25)',
    borderRadius: tokens.radius.xs,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  accountActiveText: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs,
    fontWeight: '700',
    color: tokens.colors.viridian,
    letterSpacing: 0.8,
  },
  noAccountBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(199,183,112,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(199,183,112,0.18)',
    borderRadius: tokens.radius.xs,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  noAccountText: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs,
    fontWeight: '700',
    color: tokens.colors.primary,
    letterSpacing: 0.8,
  },

  // Empty states
  emptyState: {
    alignItems: 'center',
    gap: tokens.spacing.sm,
    paddingVertical: tokens.spacing.xl,
    paddingHorizontal: tokens.spacing.lg,
  },
  emptyTitle: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.md,
    fontWeight: '700',
    color: semantic.text.primary,
    letterSpacing: 0.5,
  },
  emptyDesc: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xs,
    color: semantic.text.dim,
    textAlign: 'center',
    lineHeight: 18,
  },
  // Matches the Phoenix and Meteora connect prompts — one primary-action
  // treatment across every app's disconnected profile.
  primaryBtn: {
    marginTop: tokens.spacing.xs,
    minHeight: 42,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: tokens.colors.accent,
    paddingHorizontal: tokens.spacing.lg,
  },
  primaryBtnText: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xs,
    fontWeight: '900',
    color: semantic.background.screen,
    textTransform: 'uppercase',
  },

  // Equity card (C-16 enhanced)
  equityCard: {
    backgroundColor: semantic.background.lift,
    borderRadius: tokens.radius.md,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    padding: tokens.spacing.md,
  },
  equityRow: {
    flexDirection: 'row',
  },
  equityDivider: {
    height: 1,
    backgroundColor: semantic.border.muted,
    marginVertical: tokens.spacing.sm,
  },
  eqItem: {
    flex: 1,
    gap: 3,
  },
  eqItemCenter: {
    alignItems: 'center',
  },
  eqItemRight: {
    alignItems: 'flex-end',
  },
  eqLabel: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs,
    color: semantic.text.dim,
    letterSpacing: 0.8,
  },
  eqVal: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.sm,
    fontWeight: '700',
    color: semantic.text.primary,
  },

  // Tabs
  tabBar: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: semantic.border.muted,
  },
  tab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabActive: {
    borderBottomColor: semantic.text.primary,
  },
  tabText: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs,
    fontWeight: '700',
    letterSpacing: 1,
    color: semantic.text.dim,
    textTransform: 'uppercase',
  },
  tabTextActive: {
    color: semantic.text.primary,
  },
  tabBadge: {
    backgroundColor: semantic.background.surfaceRaised,
    borderRadius: 8,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  tabBadgeActive: {
    backgroundColor: semantic.text.primary,
  },
  tabBadgeText: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs - 2,
    fontWeight: '700',
    color: semantic.text.dim,
  },
  tabBadgeTextActive: {
    color: semantic.background.lift,
  },
  tabContent: {
    gap: tokens.spacing.xs,
  },

  // Positions
  posEmpty: {
    alignItems: 'center',
    gap: tokens.spacing.xs,
    paddingVertical: tokens.spacing.lg,
  },
  posEmptyText: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xs,
    color: semantic.text.faint,
  },
  posCard: {
    backgroundColor: semantic.background.lift,
    borderRadius: tokens.radius.md,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    overflow: 'hidden',
  },
  posRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: tokens.spacing.md,
  },
  posLeft: {
    gap: 2,
  },
  posSym: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.sm,
    fontWeight: '700',
    color: semantic.text.primary,
  },
  posSide: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs,
    letterSpacing: 0.8,
  },
  tpslStack: {
    gap: 3,
    marginTop: 4,
  },
  tpslRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  tpslLabelTP: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs - 1,
    fontWeight: '700',
    color: tokens.colors.viridian,
    letterSpacing: 0.8,
    width: 18,
  },
  tpslValueTP: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs,
    fontWeight: '600',
    color: tokens.colors.viridian,
  },
  tpslLabelSL: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs - 1,
    fontWeight: '700',
    color: tokens.colors.vermillion,
    letterSpacing: 0.8,
    width: 18,
  },
  tpslValueSL: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs,
    fontWeight: '600',
    color: tokens.colors.vermillion,
  },
  posRight: {
    flex: 1,
    alignItems: 'flex-end',
    gap: 2,
  },
  posEntry: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs,
    color: semantic.text.dim,
  },
  posPnl: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xs,
    fontWeight: '600',
  },

  // Orders tab
  orderCard: {
    backgroundColor: semantic.background.lift,
    borderRadius: tokens.radius.md,
    borderWidth: 1,
    borderColor: semantic.border.muted,
  },
  orderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: tokens.spacing.md,
  },
  orderLeft: {
    flex: 1,
    gap: 3,
  },
  orderTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  orderTypeBadge: {
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  orderTypeBadgeTP: {
    backgroundColor: 'rgba(74,140,111,0.12)',
  },
  orderTypeBadgeSL: {
    backgroundColor: 'rgba(217,83,79,0.12)',
  },
  orderTypeBadgeOther: {
    backgroundColor: semantic.background.surfaceRaised,
  },
  orderTypeText: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs - 1,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  orderDetail: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs,
    color: semantic.text.dim,
    letterSpacing: 0.5,
  },
  orderReduceOnly: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs - 1,
    color: semantic.text.faint,
    letterSpacing: 0.5,
  },
  cancelBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(217,83,79,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(217,83,79,0.2)',
  },

  // TP/SL Modal
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
  modalSubtitle: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs,
    color: semantic.text.dim,
    marginTop: -8,
  },
  modalField: {
    gap: 4,
  },
  modalLabel: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs,
    fontWeight: '700',
    color: semantic.text.dim,
    letterSpacing: 0.8,
  },
  modalInput: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.sm,
    color: semantic.text.primary,
    backgroundColor: semantic.background.surfaceRaised,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    borderRadius: tokens.radius.xs,
    paddingHorizontal: 10,
    paddingVertical: 8,
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
  modalErrorText: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs,
    color: tokens.colors.vermillion,
    textAlign: 'center',
  },

  // C-12: Remove TP/SL
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

  // C-13: Close position quick pills
  closeQuickRow: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 6,
  },
  closeQuickPill: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 4,
    borderRadius: tokens.radius.xs,
    borderWidth: 1,
    borderColor: semantic.border.muted,
  },
  closeQuickPillText: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs - 1,
    fontWeight: '700',
    color: semantic.text.dim,
    letterSpacing: 0.5,
  },

  // Action message bar (replaces Alerts)
  actionMsgBar: {
    backgroundColor: 'rgba(217,83,79,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(217,83,79,0.20)',
    borderRadius: tokens.radius.sm,
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
  },
  actionMsgText: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs,
    color: tokens.colors.vermillion,
    textAlign: 'center',
  },

  textPos: { color: tokens.colors.viridian },
  textNeg: { color: tokens.colors.vermillion },

  // Inline position action buttons
  posActionRow: {
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: tokens.spacing.md,
    paddingBottom: tokens.spacing.sm,
  },
  posActionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 7,
    borderRadius: tokens.radius.xs,
    borderWidth: 1,
    borderColor: 'rgba(199,183,112,0.25)',
    backgroundColor: 'rgba(199,183,112,0.06)',
  },
  posActionBtnClose: {
    borderColor: 'rgba(217,83,79,0.25)',
    backgroundColor: 'rgba(217,83,79,0.06)',
  },
  posActionText: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs,
    fontWeight: '700',
    letterSpacing: 0.8,
    color: tokens.colors.primary,
  },
});
