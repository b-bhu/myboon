import { useEffect, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import {
  buildPhoenixLiveSubscriptionMessages,
  normalizePhoenixLiveSymbol,
  parsePhoenixLiveMessage,
  phoenixReconnectDelayMs,
  PHOENIX_LIVE_WS_URL,
  type PhoenixLiveCandleUpdate,
  type PhoenixLiveConnectionStatus,
  type PhoenixLiveMarketStats,
} from '@/features/perps/phoenix.live';

const MESSAGE_BATCH_MS = 100;
const STALE_AFTER_MS = 15_000;

export interface PhoenixLiveMarketState {
  readonly status: PhoenixLiveConnectionStatus;
  readonly candle: PhoenixLiveCandleUpdate | null;
  readonly marketStats: PhoenixLiveMarketStats | null;
  readonly lastMessageAt: number | null;
  readonly connectionSequence: number;
}

/** Owns Phoenix socket lifecycle while exposing batched, display-ready updates. */
export function usePhoenixLiveMarket(
  symbol: string,
  timeframe: string,
  enabled = true,
): PhoenixLiveMarketState {
  const [state, setState] = useState<PhoenixLiveMarketState>(() => ({
    status: enabled ? 'connecting' : 'paused',
    candle: null,
    marketStats: null,
    lastMessageAt: null,
    connectionSequence: 0,
  }));

  useEffect(() => {
    if (!enabled) {
      setState({
        status: 'paused',
        candle: null,
        marketStats: null,
        lastMessageAt: null,
        connectionSequence: 0,
      });
      return undefined;
    }

    const venueSymbol = normalizePhoenixLiveSymbol(symbol);
    let disposed = false;
    let appIsActive = AppState.currentState === 'active';
    let socket: WebSocket | null = null;
    let reconnectAttempt = 0;
    let connectionSequence = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let staleTimer: ReturnType<typeof setTimeout> | null = null;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingCandle: PhoenixLiveCandleUpdate | null = null;
    let pendingMarketStats: PhoenixLiveMarketStats | null = null;

    const clearTimer = (timer: ReturnType<typeof setTimeout> | null) => {
      if (timer !== null) clearTimeout(timer);
    };

    const armStaleTimer = (receivedAt: number) => {
      clearTimer(staleTimer);
      staleTimer = setTimeout(() => {
        if (disposed || !appIsActive) return;
        setState((current) => (
          current.lastMessageAt !== null && current.lastMessageAt <= receivedAt
            ? { ...current, status: 'stale' }
            : current
        ));
      }, STALE_AFTER_MS);
    };

    const flushPendingMessages = () => {
      flushTimer = null;
      if (disposed || (!pendingCandle && !pendingMarketStats)) return;

      const nextCandle = pendingCandle;
      const nextMarketStats = pendingMarketStats;
      pendingCandle = null;
      pendingMarketStats = null;
      const lastMessageAt = Math.max(
        nextCandle?.receivedAt ?? 0,
        nextMarketStats?.receivedAt ?? 0,
      );

      reconnectAttempt = 0;
      setState((current) => ({
        ...current,
        status: 'live',
        candle: nextCandle ?? current.candle,
        marketStats: nextMarketStats ?? current.marketStats,
        lastMessageAt,
      }));
      armStaleTimer(lastMessageAt);
    };

    const scheduleFlush = () => {
      if (flushTimer !== null) return;
      flushTimer = setTimeout(flushPendingMessages, MESSAGE_BATCH_MS);
    };

    const closeSocket = (sendUnsubscribe: boolean) => {
      const current = socket;
      socket = null;
      if (!current) return;

      current.onopen = null;
      current.onmessage = null;
      current.onerror = null;
      current.onclose = null;
      if (sendUnsubscribe && current.readyState === WebSocket.OPEN) {
        for (const message of buildPhoenixLiveSubscriptionMessages(
          'unsubscribe',
          venueSymbol,
          timeframe,
        )) {
          current.send(JSON.stringify(message));
        }
      }
      if (
        current.readyState === WebSocket.OPEN
        || current.readyState === WebSocket.CONNECTING
      ) {
        current.close();
      }
    };

    const scheduleReconnect = () => {
      if (disposed || !appIsActive || reconnectTimer !== null) return;
      setState((current) => ({ ...current, status: 'reconnecting' }));
      const delay = phoenixReconnectDelayMs(reconnectAttempt);
      reconnectAttempt += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    };

    const connect = () => {
      if (disposed || !appIsActive) return;
      clearTimer(reconnectTimer);
      reconnectTimer = null;
      closeSocket(false);
      setState((current) => ({
        ...current,
        status: connectionSequence === 0 ? 'connecting' : 'reconnecting',
      }));

      const current = new WebSocket(PHOENIX_LIVE_WS_URL);
      socket = current;

      current.onopen = () => {
        if (disposed || socket !== current || !appIsActive) return;
        connectionSequence += 1;
        setState((previous) => ({ ...previous, connectionSequence }));
        for (const message of buildPhoenixLiveSubscriptionMessages(
          'subscribe',
          venueSymbol,
          timeframe,
        )) {
          current.send(JSON.stringify(message));
        }
      };

      current.onmessage = (event: MessageEvent<string>) => {
        if (disposed || socket !== current || !appIsActive) return;
        const message = parsePhoenixLiveMessage(event.data);
        if (!message || message.symbol !== venueSymbol) return;
        if (message.kind === 'candle') {
          if (message.timeframe !== timeframe) return;
          pendingCandle = message;
        } else {
          pendingMarketStats = message;
        }
        scheduleFlush();
      };

      current.onerror = () => {
        if (socket === current) current.close();
      };

      current.onclose = () => {
        if (socket !== current) return;
        socket = null;
        clearTimer(staleTimer);
        staleTimer = null;
        clearTimer(flushTimer);
        flushTimer = null;
        pendingCandle = null;
        pendingMarketStats = null;
        scheduleReconnect();
      };
    };

    const handleAppStateChange = (nextState: AppStateStatus) => {
      const nextIsActive = nextState === 'active';
      if (nextIsActive === appIsActive) return;
      appIsActive = nextIsActive;

      if (!appIsActive) {
        clearTimer(reconnectTimer);
        reconnectTimer = null;
        clearTimer(staleTimer);
        staleTimer = null;
        clearTimer(flushTimer);
        flushTimer = null;
        pendingCandle = null;
        pendingMarketStats = null;
        closeSocket(true);
        setState((current) => ({ ...current, status: 'paused' }));
        return;
      }

      connect();
    };

    setState({
      status: appIsActive ? 'connecting' : 'paused',
      candle: null,
      marketStats: null,
      lastMessageAt: null,
      connectionSequence: 0,
    });
    const appStateSubscription = AppState.addEventListener('change', handleAppStateChange);
    if (appIsActive) connect();

    return () => {
      disposed = true;
      appStateSubscription.remove();
      clearTimer(reconnectTimer);
      clearTimer(staleTimer);
      clearTimer(flushTimer);
      closeSocket(true);
    };
  }, [enabled, symbol, timeframe]);

  return state;
}
