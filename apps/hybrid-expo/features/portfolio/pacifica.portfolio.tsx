/**
 * Pacifica per-venue portfolio drill-down (#657, D2).
 *
 * Moves the retired `features/perps/PacificaProfileScreen.tsx` onto the shared
 * VenuePortfolioScreen shell with the fixed Positions · Orders · History tabs.
 * State, 30s polling, the local trade-history store and every execution path
 * are moved verbatim: close via closePosition, TP/SL via setTPSL / removeTPSL,
 * cancels via cancelOrder / cancelStopOrder — all from
 * `features/perps/perps.signed-api`, exactly as the retired screen called
 * them. No new execution path; tapping a position opens the existing close
 * modal pre-filled with it.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { createTradeHistoryStore, makeTradeRecordId } from '@/features/perps/tradeHistoryStore';
import type { TradeRecord } from '@/features/perps/tradeHistoryStore';
import { VenuePortfolioScreen } from '@/features/portfolio/VenuePortfolioScreen';
import type { VenuePortfolioScreenTab } from '@/features/portfolio/VenuePortfolioScreen';
import { semantic, tokens } from '@/theme';



const LazyPacificaDepositModal = lazy(() =>
  import('@/features/perps/PacificaDepositModal').then((module) => ({ default: module.PacificaDepositModal })),
);
const LazyPacificaWithdrawModal = lazy(() =>
  import('@/features/perps/PacificaWithdrawModal').then((module) => ({ default: module.PacificaWithdrawModal })),
);

// C-15: Trade history stored in AsyncStorage
const tradeHistoryStore = createTradeHistoryStore({
  getItem: (key) => AsyncStorage.getItem(key),
  setItem: (key, value) => AsyncStorage.setItem(key, value),
});

function truncate(addr: string, start = 6, end = 4): string {
  return `\${addr.slice(0, start)}···\${addr.slice(-end)}`;
}

function orderTypeLabel(type: string): string {
  if (type === 'take_profit_limit') return 'Take Profit';
  if (type === 'stop_loss_limit') return 'Stop Loss';
  if (type.includes('limit')) return 'Limit';
  if (type.includes('market')) return 'Market';
  return type;
}

// C-14: Polling interval (30 seconds)
const POLL_INTERVAL = 30_000;


export function PacificaPortfolioScreen() {

  const { connected, address, signMessage } = useWallet();
  const connectSheet = useConnectionSheet('solana');
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
    tradeHistoryStore.loadTradeHistory().then(setTradeHistory);
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
      try {
        await tradeHistoryStore.saveTradeRecord({
          id: makeTradeRecordId(pos.symbol),
          symbol: pos.symbol,
          side: pos.side,
          size: sizeToClose,
          entryPrice: pos.entryPrice,
          exitPrice: pos.markPrice,
          pnl: pos.unrealizedPnl * (sizeToClose / pos.size),
          closedAt: Date.now(),
          type: 'market_close',
        });
        tradeHistoryStore.loadTradeHistory().then(setTradeHistory);
      } catch {
        setActionMsg('Position closed, but trade history could not be saved.');
      }
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


  const tabs = useMemo(() => {
    const ready = accountChecked && connected;
    const build = (
      rows: VenuePortfolioScreenTab['sections'],
    ): VenuePortfolioScreenTab => ({ status: ready ? 'ready' : 'loading', sections: rows });

    const messageBelow: VenuePortfolioScreenTab['below'] = actionMsg !== '' ? (
      <View style={styles.actionMsgBar}>
        <Text style={styles.actionMsgText}>{actionMsg}</Text>
      </View>
    ) : null;

    const positionRows = positions.map((pos) => {
      const isUp = pos.unrealizedPnl >= 0;
      const tpsl = tpslBySymbol[pos.symbol];
      const hasTpsl = !!(tpsl?.tp || tpsl?.sl);
      return {
        key: pos.symbol,
        title: pos.symbol,
        titleAccent: pos.side.toUpperCase(),
        subtitle: [
          `${pos.size} @ ${formatPrice(pos.entryPrice)}`,
          tpsl?.tp ? `TP ${formatPrice(tpsl.tp.stopPrice!)}` : null,
          tpsl?.sl ? `SL ${formatPrice(tpsl.sl.stopPrice!)}` : null,
          'reduceOnly' in pos && pos.reduceOnly ? 'Reduce only' : null,
        ].filter(Boolean).join(' · '),
        value: `${isUp ? '+' : ''}${pos.unrealizedPnl.toFixed(2)}`,
        valueTone: isUp ? ('pos' as const) : ('neg' as const),
        subValue: `${pos.unrealizedPnlPct.toFixed(1)}%`,
        subValueTone: isUp ? ('pos' as const) : ('neg' as const),
        actionLabel: hasTpsl ? 'Edit TP/SL' : 'TP/SL',
        actionPending: actionLoading,
        actionDisabled: actionLoading,
        onActionPress: () => openTPSLModal(pos),
        onPress: () => {
          setClosePosition_(pos);
          setCloseAmountText(pos.size.toString());
          setActionMsg('');
        },
      };
    });

    const orderRows = orders.map((order) => {
      const isTP = order.orderType === 'take_profit_limit';
      const isSL = order.orderType === 'stop_loss_limit';
      return {
        key: String(order.orderId),
        title: order.symbol,
        titleAccent: order.side === 'bid' ? 'Buy' : 'Sell',
        subtitle: [orderTypeLabel(order.orderType), order.reduceOnly ? 'Reduce only' : null]
          .filter(Boolean)
          .join(' · '),
        value: formatPrice(order.stopPrice ?? order.price),
        valueTone: isTP ? ('pos' as const) : isSL ? ('neg' as const) : undefined,
        actionLabel: 'Cancel',
        actionPending: actionLoading,
        actionDisabled: actionLoading,
        onActionPress: () => void handleCancelOrder(order),
        onPress: undefined,
      };
    });

    const historyRows = tradeHistory.map((trade) => {
      const isUp = trade.pnl >= 0;
      return {
        key: trade.id,
        title: trade.symbol,
        titleAccent: trade.side.toUpperCase(),
        subtitle: `${trade.size} · Entry ${formatPrice(trade.entryPrice)} → ${formatPrice(trade.exitPrice)}`,
        value: `${isUp ? '+' : ''}$${trade.pnl.toFixed(2)}`,
        valueTone: isUp ? ('pos' as const) : ('neg' as const),
        subValue: `${new Date(trade.closedAt).toLocaleDateString()} ${new Date(trade.closedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
      };
    });

    const emptyCopy = {
      positions: { title: 'No open positions', message: 'Positions you open on Pacifica appear here.' },
      orders: { title: 'No open orders', message: 'Limit orders you place will appear here until they fill.' },
      history: { title: 'No trade history yet', message: 'Closed positions will appear here.' },
    };

    return {
      positions: {
        ...build([{ key: 'positions', label: 'Open positions', rows: positionRows }]),
        empty: ready ? emptyCopy.positions : null,
        above: noPacificAccount ? (
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
        ) : null,
        below: messageBelow,
      },
      orders: {
        ...build([{ key: 'orders', label: 'Open orders', rows: orderRows }]),
        empty: ready ? emptyCopy.orders : null,
        below: messageBelow,
      },
      history: {
        ...build([{ key: 'history', label: 'History', rows: historyRows }]),
        empty: ready ? emptyCopy.history : null,
        below: messageBelow,
      },
    };
  }, [
    accountChecked, connected, positions, tpslBySymbol, orders, tradeHistory, actionLoading,
    actionMsg, noPacificAccount, openTPSLModal, handleCancelOrder,
  ]);

  if (!connected) {
    return (
      <>
        <View style={styles.container}>
                    <View style={styles.emptyState}>
            <MaterialIcons name="account-balance-wallet" size={28} color={semantic.text.faint} />
            <Text style={styles.emptyTitle}>Connect wallet</Text>
            <Text style={styles.emptyDesc}>
              Connect a wallet to view your Pacifica trading account.
            </Text>
            <Pressable style={styles.primaryBtn} onPress={() => connectSheet.open('solana')}>
              <Text style={styles.primaryBtnText}>Connect wallet</Text>
            </Pressable>
          </View>
        </View>
        <ConnectionSheet
          visible={connectSheet.visible}
          chain={connectSheet.chain}
          onClose={connectSheet.close}
        />
      </>
    );
  }

  return (
    <>
      <VenuePortfolioScreen
        venueId="pacifica"
        hero={{
          value: account ? `$${account.equity.toFixed(2)}` : '--',
          change: totalUnrealizedPnl === 0 ? null : `${totalUnrealizedPnl >= 0 ? '+' : ''}${totalUnrealizedPnl.toFixed(2)} unrealized`,
          changeTone: totalUnrealizedPnl >= 0 ? 'pos' : 'neg',
          note: account
            ? `Margin $${account.totalMarginUsed.toFixed(2)} · Available $${account.availableToSpend.toFixed(2)} · Leverage ${accountLeverage.toFixed(2)}x · Positions ${positions.length}`
            : 'Loading Pacifica account…',
        }}
        onDeposit={hasPacificAccount ? () => setDepositOpen(true) : undefined}
        onWithdraw={hasPacificAccount ? () => setWithdrawOpen(true) : undefined}
        tabs={tabs}
        refreshing={refreshing}
        onRefresh={onRefresh}
        testID="pacifica-portfolio"
      />

      {depositModalLoaded && (
        <Suspense fallback={null}>
          <LazyPacificaDepositModal
            visible={depositOpen}
            onClose={() => setDepositOpen(false)}
            onRequestConnect={() => connectSheet.open('solana')}
          />
        </Suspense>
      )}
      {withdrawModalLoaded && (
        <Suspense fallback={null}>
          <LazyPacificaWithdrawModal
            visible={withdrawOpen}
            onClose={() => setWithdrawOpen(false)}
            onRequestConnect={() => connectSheet.open('solana')}
          />
        </Suspense>
      )}

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

            <ConnectionSheet
        visible={connectSheet.visible}
        chain={connectSheet.chain}
        onClose={connectSheet.close}
      />
    </>
  );
}



const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
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
});
