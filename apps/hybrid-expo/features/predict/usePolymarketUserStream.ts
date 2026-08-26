import { useEffect, useRef, useState } from 'react';
import type { SecureClient } from '@polymarket/client';
import type { OpenOrder } from './predict.api';

type UserStreamEvent = {
  topic?: string;
  type?: string;
  payload?: Record<string, unknown>;
};

interface UserStreamListener {
  onEvent: (event: unknown) => void;
  onResync: () => void | Promise<void>;
  onStatus: (status: PredictRealtimeStatus) => void;
}

interface UserStreamSession {
  listeners: Set<UserStreamListener>;
  handle: Awaited<ReturnType<SecureClient['subscribe']>> | null;
  stopped: boolean;
  cancelRetry: (() => void) | null;
  fallbackPoll: ReturnType<typeof globalThis.setInterval> | null;
  resyncing: Promise<boolean> | null;
  socketConnected: boolean;
  recovery: UserStreamRecoveryState;
  status: PredictRealtimeStatus;
}

const userStreamSessions = new WeakMap<SecureClient, UserStreamSession>();

export type PredictRealtimeStatus = 'idle' | 'connecting' | 'live' | 'degraded';

export interface UserStreamRecoveryState {
  attempt: number;
  needsResync: boolean;
}

const USER_STREAM_RETRY_BASE_MS = 1_000;
const USER_STREAM_RETRY_CAP_MS = 30_000;
export const DEGRADED_USER_STREAM_POLL_MS = 30_000;

export function userStreamRetryDelay(attempt: number, random = Math.random): number {
  const exponential = USER_STREAM_RETRY_BASE_MS * (2 ** Math.max(0, attempt));
  const jittered = exponential * (0.8 + (random() * 0.4));
  return Math.min(USER_STREAM_RETRY_CAP_MS, Math.max(250, Math.round(jittered)));
}

export function recordUserStreamLoss(state: UserStreamRecoveryState): UserStreamRecoveryState {
  return { attempt: state.attempt + 1, needsResync: true };
}

export function recordUserStreamConnected(state: UserStreamRecoveryState): {
  state: UserStreamRecoveryState;
  shouldResync: boolean;
} {
  return {
    // Keep the accumulated attempt count until the socket proves stable. A
    // handshake that immediately closes must continue backing off.
    state: { attempt: state.attempt, needsResync: state.needsResync },
    shouldResync: state.needsResync,
  };
}

export function recordUserStreamStable(state: UserStreamRecoveryState): UserStreamRecoveryState {
  return { attempt: 0, needsResync: state.needsResync };
}

export function recordUserStreamResynced(state: UserStreamRecoveryState): UserStreamRecoveryState {
  return { attempt: state.attempt, needsResync: false };
}

export async function attemptUserStreamRecovery(
  state: UserStreamRecoveryState,
  refreshes: readonly (() => void | Promise<void>)[],
): Promise<{
  state: UserStreamRecoveryState;
  status: 'live' | 'degraded';
  succeeded: boolean;
}> {
  const results = await Promise.allSettled(refreshes.map(async (refresh) => {
    await refresh();
  }));
  const succeeded = results.every((result) => result.status === 'fulfilled');
  return {
    state: succeeded ? recordUserStreamResynced(state) : state,
    status: succeeded ? 'live' : 'degraded',
    succeeded,
  };
}

export function isPredictTradeEvent(rawEvent: unknown): boolean {
  return Boolean(
    rawEvent
    && typeof rawEvent === 'object'
    && (rawEvent as UserStreamEvent).type === 'trade',
  );
}

function eventNumber(value: unknown): number {
  const parsed = typeof value === 'string' ? Number.parseFloat(value) : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Apply user-stream order/trade events immediately; REST remains the resync authority. */
export function applyPredictUserEvent(openOrders: OpenOrder[], rawEvent: unknown): OpenOrder[] {
  if (!rawEvent || typeof rawEvent !== 'object') return openOrders;
  const event = rawEvent as UserStreamEvent;
  const payload = event.payload;
  if (!payload) return openOrders;

  if (event.type === 'order') {
    const id = typeof payload.id === 'string' ? payload.id : null;
    if (!id) return openOrders;
    if (payload.orderEventType === 'CANCELLATION') {
      return openOrders.filter((order) => order.id !== id);
    }
    const current = openOrders.find((order) => order.id === id);
    const next: OpenOrder = {
      id,
      status: typeof payload.status === 'string' ? payload.status : 'live',
      market: typeof payload.market === 'string' ? payload.market : '',
      asset_id: typeof payload.tokenId === 'string' ? payload.tokenId : '',
      side: typeof payload.side === 'string' ? payload.side : '',
      original_size: String(payload.originalSize ?? '0'),
      size_matched: String(payload.sizeMatched ?? '0'),
      price: String(payload.price ?? '0'),
      outcome: typeof payload.outcome === 'string' ? payload.outcome : '',
      created_at: typeof payload.createdAt === 'string'
        ? Date.parse(payload.createdAt)
        : eventNumber(payload.timestamp),
      order_type: typeof payload.orderType === 'string' ? payload.orderType : 'GTC',
      associate_trades: Array.isArray(payload.associateTrades)
        ? payload.associateTrades.filter((trade): trade is string => typeof trade === 'string')
        : current?.associate_trades ?? [],
    };
    const remaining = eventNumber(next.original_size) - eventNumber(next.size_matched);
    if (remaining <= 0) return openOrders.filter((order) => order.id !== id);
    return [next, ...openOrders.filter((order) => order.id !== id)];
  }

  if (event.type === 'trade') {
    const tradeId = typeof payload.id === 'string' ? payload.id : null;
    const fills = new Map<string, number>();
    if (typeof payload.takerOrderId === 'string') {
      fills.set(payload.takerOrderId, eventNumber(payload.size));
    }
    if (Array.isArray(payload.makerOrders)) {
      for (const maker of payload.makerOrders) {
        if (!maker || typeof maker !== 'object') continue;
        const entry = maker as Record<string, unknown>;
        if (typeof entry.orderId === 'string') fills.set(entry.orderId, eventNumber(entry.matchedAmount));
      }
    }
    return openOrders
      .map((order) => {
        const fill = fills.get(order.id);
        if (!fill) return order;
        if (tradeId && order.associate_trades?.includes(tradeId)) return order;
        return {
          ...order,
          size_matched: String(eventNumber(order.size_matched) + fill),
          associate_trades: tradeId
            ? [...(order.associate_trades ?? []), tradeId]
            : order.associate_trades,
        };
      })
      .filter((order) => eventNumber(order.size_matched) < eventNumber(order.original_size));
  }

  return openOrders;
}

/**
 * Maintains the authenticated user stream while a Predict screen is active.
 * Stream events are incremental; loss uses bounded retries and REST fallback,
 * followed by one authoritative refresh at a successful reconnect boundary.
 */
async function resyncListeners(session: UserStreamSession): Promise<boolean> {
  if (session.resyncing) return session.resyncing;
  const listeners = [...session.listeners];
  const resync = attemptUserStreamRecovery(
    session.recovery,
    listeners.map((listener) => listener.onResync),
  ).then((result) => result.succeeded);
  session.resyncing = resync;
  try {
    return await resync;
  } finally {
    if (session.resyncing === resync) session.resyncing = null;
  }
}

async function recoverSession(session: UserStreamSession): Promise<boolean> {
  const succeeded = await resyncListeners(session);
  if (succeeded) session.recovery = recordUserStreamResynced(session.recovery);
  return succeeded;
}

function broadcastStatus(session: UserStreamSession, status: PredictRealtimeStatus): void {
  if (status === 'degraded' && !session.fallbackPoll) {
    session.fallbackPoll = globalThis.setInterval(() => {
      if (!session.stopped && session.status === 'degraded') {
        void recoverSession(session).then((succeeded) => {
          if (succeeded && session.socketConnected) broadcastStatus(session, 'live');
        });
      }
    }, DEGRADED_USER_STREAM_POLL_MS);
  } else if (status !== 'degraded' && session.fallbackPoll) {
    globalThis.clearInterval(session.fallbackPoll);
    session.fallbackPoll = null;
  }
  if (session.status === status) return;
  session.status = status;
  session.listeners.forEach((listener) => listener.onStatus(status));
}

function waitForRetry(session: UserStreamSession, delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      session.cancelRetry = null;
      resolve();
    };
    const timer = globalThis.setTimeout(finish, delayMs);
    session.cancelRetry = () => {
      globalThis.clearTimeout(timer);
      finish();
    };
  });
}

async function runUserStream(client: SecureClient, session: UserStreamSession): Promise<void> {
  while (!session.stopped) {
    let stabilityTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
    try {
      session.handle = await client.subscribe([{ topic: 'user' }]);
      if (session.stopped) break;
      session.socketConnected = true;
      const connected = recordUserStreamConnected(session.recovery);
      session.recovery = connected.state;
      // Loss is resynced once at the successful reconnect boundary. Failed
      // connection attempts never fan out into repeated REST refreshes.
      if (connected.shouldResync) await recoverSession(session);
      broadcastStatus(session, session.recovery.needsResync ? 'degraded' : 'live');
      const connectedHandle = session.handle;
      stabilityTimer = globalThis.setTimeout(() => {
        if (!session.stopped && session.handle === connectedHandle) {
          session.recovery = recordUserStreamStable(session.recovery);
        }
      }, USER_STREAM_RETRY_CAP_MS);
      for await (const event of session.handle) {
        if (session.stopped) break;
        session.recovery = recordUserStreamStable(session.recovery);
        session.listeners.forEach((listener) => listener.onEvent(event));
      }
      if (!session.stopped) throw new Error('Predict user stream ended.');
    } catch {
      if (session.stopped) break;
      session.socketConnected = false;
      const retryDelay = userStreamRetryDelay(session.recovery.attempt);
      session.recovery = recordUserStreamLoss(session.recovery);
      broadcastStatus(session, 'degraded');
      await waitForRetry(session, retryDelay);
    } finally {
      if (stabilityTimer) globalThis.clearTimeout(stabilityTimer);
      session.socketConnected = false;
      await session.handle?.close().catch(() => {});
      session.handle = null;
    }
  }
}

export function usePolymarketUserStream(
  client: SecureClient | null,
  onEvent: (event: unknown) => void,
  onResync: () => void | Promise<void>,
): PredictRealtimeStatus {
  const [status, setStatus] = useState<PredictRealtimeStatus>(client ? 'connecting' : 'idle');
  const eventRef = useRef(onEvent);
  const resyncRef = useRef(onResync);
  eventRef.current = onEvent;
  resyncRef.current = onResync;

  useEffect(() => {
    if (!client) {
      setStatus('idle');
      return;
    }
    const listener: UserStreamListener = {
      onEvent: (event) => eventRef.current(event),
      onResync: () => resyncRef.current(),
      onStatus: setStatus,
    };
    let session = userStreamSessions.get(client);
    let shouldStart = false;
    if (!session) {
      session = {
        listeners: new Set(),
        handle: null,
        stopped: false,
        cancelRetry: null,
        fallbackPoll: null,
        resyncing: null,
        socketConnected: false,
        recovery: { attempt: 0, needsResync: false },
        status: 'connecting',
      };
      userStreamSessions.set(client, session);
      shouldStart = true;
    }
    session.listeners.add(listener);
    listener.onStatus(session.status);
    void Promise.resolve(listener.onResync()).catch(() => {});
    if (shouldStart) void runUserStream(client, session);

    return () => {
      session?.listeners.delete(listener);
      if (session && session.listeners.size === 0) {
        session.stopped = true;
        session.cancelRetry?.();
        if (session.fallbackPoll) globalThis.clearInterval(session.fallbackPoll);
        session.fallbackPoll = null;
        void session.handle?.close().catch(() => {});
        userStreamSessions.delete(client);
      }
    };
  }, [client]);

  return status;
}
