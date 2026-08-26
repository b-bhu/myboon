import { useEffect, useRef } from 'react';
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
}

interface UserStreamSession {
  listeners: Set<UserStreamListener>;
  handle: Awaited<ReturnType<SecureClient['subscribe']>> | null;
  stopped: boolean;
}

const userStreamSessions = new WeakMap<SecureClient, UserStreamSession>();

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
 * Stream events are incremental; a lost connection triggers an authoritative
 * REST refresh before reconnecting.
 */
async function resyncListeners(session: UserStreamSession): Promise<void> {
  await Promise.allSettled([...session.listeners].map((listener) => listener.onResync()));
}

async function runUserStream(client: SecureClient, session: UserStreamSession): Promise<void> {
  while (!session.stopped) {
    try {
      session.handle = await client.subscribe([{ topic: 'user' }]);
      for await (const event of session.handle) {
        if (session.stopped) break;
        session.listeners.forEach((listener) => listener.onEvent(event));
      }
      if (!session.stopped) throw new Error('Predict user stream ended.');
    } catch {
      if (session.stopped) break;
      await resyncListeners(session);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    } finally {
      await session.handle?.close().catch(() => {});
      session.handle = null;
    }
  }
}

export function usePolymarketUserStream(
  client: SecureClient | null,
  onEvent: (event: unknown) => void,
  onResync: () => void | Promise<void>,
): void {
  const eventRef = useRef(onEvent);
  const resyncRef = useRef(onResync);
  eventRef.current = onEvent;
  resyncRef.current = onResync;

  useEffect(() => {
    if (!client) return;
    const listener: UserStreamListener = {
      onEvent: (event) => eventRef.current(event),
      onResync: () => resyncRef.current(),
    };
    let session = userStreamSessions.get(client);
    if (!session) {
      session = { listeners: new Set(), handle: null, stopped: false };
      userStreamSessions.set(client, session);
      void runUserStream(client, session);
    }
    session.listeners.add(listener);
    void Promise.resolve(listener.onResync()).catch(() => {});

    return () => {
      session?.listeners.delete(listener);
      if (session && session.listeners.size === 0) {
        session.stopped = true;
        void session.handle?.close().catch(() => {});
        userStreamSessions.delete(client);
      }
    };
  }, [client]);
}
