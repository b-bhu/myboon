import bs58 from 'bs58';
import type { PerpsOrder, RawMarketInfo, RawPriceInfo } from '@/features/perps/perps.types';
import { fetchWithTimeout } from '@/lib/api';
import { PACIFIC_REST } from '@/features/perps/pacific.config';
import { pacificGet } from '@/features/perps/perps.public-api';
import { safeNum } from '@myboon/shared/wallet-summary';

export type SignMessageFn = ((message: Uint8Array) => Promise<Uint8Array>) | null;

function sortJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortJsonKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function buildSigningMessage(
  type: string,
  payload: Record<string, unknown>,
  timestamp: number,
  expiryWindow: number = 60000,
): string {
  const header = {
    timestamp,
    expiry_window: expiryWindow,
    type,
    data: payload,
  };
  return JSON.stringify(sortJsonKeys(header));
}

async function pacificSignedPost(
  path: string,
  type: string,
  payload: Record<string, unknown>,
  account: string,
  signMessage: SignMessageFn,
  expiryWindow: number = 30000,
): Promise<any> {
  if (!signMessage) {
    throw new Error('Wallet does not support message signing');
  }

  const timestamp = Date.now();
  const message = buildSigningMessage(type, payload, timestamp, expiryWindow);
  const messageBytes = new TextEncoder().encode(message);
  const signatureBytes = await signMessage(messageBytes);
  const encoded = bs58.encode(signatureBytes);

  const body = {
    account,
    signature: encoded,
    timestamp,
    expiry_window: expiryWindow,
    ...payload,
  };

  const res = await fetchWithTimeout(`${PACIFIC_REST}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (res.status === 429) throw new Error('Rate limit — try again shortly');
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Bad response from Pacific (HTTP ${res.status}): ${text.slice(0, 100)}`);
  }
  if (!res.ok || json.success === false) {
    const err = new Error(json.error ?? json.message ?? text ?? `HTTP ${res.status}`);
    (err as any).code = json.code ?? res.status;
    throw err;
  }
  return json;
}

export async function cancelOrder(
  orderId: number,
  symbol: string,
  account: string,
  signMessage: SignMessageFn,
): Promise<void> {
  await pacificSignedPost('/orders/cancel', 'cancel_order', { symbol, order_id: orderId }, account, signMessage);
}

export async function cancelStopOrder(
  orderId: number,
  symbol: string,
  account: string,
  signMessage: SignMessageFn,
): Promise<void> {
  await pacificSignedPost('/orders/stop/cancel', 'cancel_stop_order', { symbol, order_id: orderId }, account, signMessage);
}

export async function removeTPSL(
  symbol: string,
  side: 'bid' | 'ask',
  remove: 'tp' | 'sl' | 'both',
  account: string,
  signMessage: SignMessageFn,
  currentOrders: PerpsOrder[],
): Promise<void> {
  const payload: Record<string, unknown> = { symbol, side };

  if (remove === 'tp' || remove === 'both') {
    payload.take_profit = { stop_price: '0', limit_price: '0', client_order_id: crypto.randomUUID() };
  } else {
    const tp = currentOrders.find(o => o.symbol === symbol && o.orderType === 'take_profit_limit');
    if (tp?.stopPrice) {
      payload.take_profit = {
        stop_price: tp.stopPrice.toString(),
        limit_price: tp.stopPrice.toString(),
        client_order_id: crypto.randomUUID(),
      };
    }
  }

  if (remove === 'sl' || remove === 'both') {
    payload.stop_loss = { stop_price: '0', limit_price: '0', client_order_id: crypto.randomUUID() };
  } else {
    const sl = currentOrders.find(o => o.symbol === symbol && o.orderType === 'stop_loss_limit');
    if (sl?.stopPrice) {
      payload.stop_loss = {
        stop_price: sl.stopPrice.toString(),
        limit_price: sl.stopPrice.toString(),
        client_order_id: crypto.randomUUID(),
      };
    }
  }

  await pacificSignedPost('/positions/tpsl', 'set_position_tpsl', payload, account, signMessage);
}

export async function approveBuilderCode(
  builderCode: string,
  maxFeeRate: string,
  account: string,
  signMessage: SignMessageFn,
): Promise<void> {
  await pacificSignedPost(
    '/account/builder_codes/approve',
    'approve_builder_code',
    { builder_code: builderCode, max_fee_rate: maxFeeRate },
    account,
    signMessage,
  );
}

async function withBuilderCodeRetry<T>(
  fn: () => Promise<T>,
  fnWithoutBuilder: () => Promise<T>,
  builderCode: string | undefined,
  account: string,
  signMessage: SignMessageFn,
): Promise<T> {
  if (!builderCode) return fn();
  try {
    return await fn();
  } catch (err: any) {
    const msg = err?.message ?? '';
    if (msg.includes('has not approved builder code')) {
      try {
        if (__DEV__) console.log('[Pacific] Auto-approving builder code:', builderCode);
        await approveBuilderCode(builderCode, '0.001', account, signMessage);
        return await fn();
      } catch {
        if (__DEV__) console.log('[Pacific] Builder code unavailable, placing without it');
        return await fnWithoutBuilder();
      }
    }
    if (msg.includes('Builder code not found') || msg.includes('builder_code')) {
      if (__DEV__) console.log('[Pacific] Builder code not found, placing without it');
      return await fnWithoutBuilder();
    }
    throw err;
  }
}

export async function placeOrder(
  params: {
    symbol: string;
    side: 'bid' | 'ask';
    amountUsdc: number;
    slippage: string;
    builderCode?: string;
  },
  account: string,
  signMessage: SignMessageFn,
): Promise<number> {
  const [markets, prices] = await Promise.all([
    pacificGet<RawMarketInfo[]>('/info'),
    pacificGet<RawPriceInfo[]>('/info/prices'),
  ]);
  const market = markets.find((m) => m.symbol === params.symbol);
  const price = prices.find((p) => p.symbol === params.symbol);
  if (!market || !price) throw new Error(`Market ${params.symbol} not found`);

  const markPrice = safeNum(price.mark);
  if (markPrice <= 0) throw new Error('Invalid mark price');

  const rawAmount = params.amountUsdc / markPrice;
  const lotSize = parseFloat(market.lot_size);
  const amount = lotSize > 0
    ? Math.floor(rawAmount / lotSize) * lotSize
    : rawAmount;

  if (amount <= 0) {
    throw new Error(`Amount too small — minimum lot size is ${market.lot_size} ${params.symbol}`);
  }

  const decimals = market.lot_size.includes('.')
    ? market.lot_size.split('.')[1].length
    : 0;
  const amountStr = amount.toFixed(decimals);

  const payload: Record<string, unknown> = {
    symbol: params.symbol,
    side: params.side,
    amount: amountStr,
    slippage_percent: params.slippage,
    reduce_only: false,
    client_order_id: crypto.randomUUID(),
  };
  if (params.builderCode) {
    payload.builder_code = params.builderCode;
  }

  const payloadNoBuilder = { ...payload };
  delete payloadNoBuilder.builder_code;

  const res = await withBuilderCodeRetry(
    () => pacificSignedPost('/orders/create_market', 'create_market_order', payload, account, signMessage),
    () => pacificSignedPost('/orders/create_market', 'create_market_order', payloadNoBuilder, account, signMessage),
    params.builderCode,
    account,
    signMessage,
  );
  return res.data?.order_id ?? res.order_id;
}

export async function placeLimitOrder(
  params: {
    symbol: string;
    side: 'bid' | 'ask';
    price: number;
    amountUsdc: number;
    tif?: 'GTC' | 'IOC' | 'ALO' | 'TOB';
    reduceOnly?: boolean;
    builderCode?: string;
  },
  account: string,
  signMessage: SignMessageFn,
): Promise<number> {
  const markets = await pacificGet<RawMarketInfo[]>('/info');
  const market = markets.find((m) => m.symbol === params.symbol);
  if (!market) throw new Error(`Market ${params.symbol} not found`);

  if (params.price <= 0) throw new Error('Invalid limit price');

  const rawAmount = params.amountUsdc / params.price;
  const lotSize = parseFloat(market.lot_size);
  const amount = lotSize > 0
    ? Math.floor(rawAmount / lotSize) * lotSize
    : rawAmount;

  if (amount <= 0) {
    throw new Error(`Amount too small — minimum lot size is ${market.lot_size} ${params.symbol}`);
  }

  const tickDecimals = market.tick_size.includes('.')
    ? market.tick_size.split('.')[1].length
    : 0;
  const lotDecimals = market.lot_size.includes('.')
    ? market.lot_size.split('.')[1].length
    : 0;

  const payload: Record<string, unknown> = {
    symbol: params.symbol,
    side: params.side,
    price: params.price.toFixed(tickDecimals),
    amount: amount.toFixed(lotDecimals),
    tif: params.tif ?? 'GTC',
    reduce_only: params.reduceOnly ?? false,
    client_order_id: crypto.randomUUID(),
  };
  if (params.builderCode) {
    payload.builder_code = params.builderCode;
  }

  const payloadNoBuilder = { ...payload };
  delete payloadNoBuilder.builder_code;

  const res = await withBuilderCodeRetry(
    () => pacificSignedPost('/orders/create', 'create_order', payload, account, signMessage),
    () => pacificSignedPost('/orders/create', 'create_order', payloadNoBuilder, account, signMessage),
    params.builderCode,
    account,
    signMessage,
  );
  return res.data?.order_id ?? res.order_id;
}

export async function closePosition(
  symbol: string,
  side: 'bid' | 'ask',
  amount: number,
  account: string,
  signMessage: SignMessageFn,
  builderCode?: string,
): Promise<number> {
  const markets = await pacificGet<RawMarketInfo[]>('/info');
  const market = markets.find((m) => m.symbol === symbol);
  if (!market) throw new Error(`Market ${symbol} not found`);

  const lotSize = parseFloat(market.lot_size);
  const rounded = lotSize > 0
    ? Math.floor(amount / lotSize) * lotSize
    : amount;

  const decimals = market.lot_size.includes('.')
    ? market.lot_size.split('.')[1].length
    : 0;
  const amountStr = rounded.toFixed(decimals);

  const payload: Record<string, unknown> = {
    symbol,
    side,
    amount: amountStr,
    slippage_percent: '1',
    reduce_only: true,
    client_order_id: crypto.randomUUID(),
  };
  if (builderCode) {
    payload.builder_code = builderCode;
  }

  const payloadNoBuilder = { ...payload };
  delete payloadNoBuilder.builder_code;

  const res = await withBuilderCodeRetry(
    () => pacificSignedPost('/orders/create_market', 'create_market_order', payload, account, signMessage),
    () => pacificSignedPost('/orders/create_market', 'create_market_order', payloadNoBuilder, account, signMessage),
    builderCode,
    account,
    signMessage,
  );
  return res.data?.order_id ?? res.order_id;
}

export async function setTPSL(
  params: {
    symbol: string;
    side: 'bid' | 'ask';
    takeProfit?: { stopPrice: string; limitPrice: string };
    stopLoss?: { stopPrice: string; limitPrice: string };
    builderCode?: string;
  },
  account: string,
  signMessage: SignMessageFn,
): Promise<void> {
  const payload: Record<string, unknown> = {
    symbol: params.symbol,
    side: params.side,
  };

  if (params.takeProfit) {
    payload.take_profit = {
      stop_price: params.takeProfit.stopPrice,
      limit_price: params.takeProfit.limitPrice,
      client_order_id: crypto.randomUUID(),
    };
  }

  if (params.stopLoss) {
    payload.stop_loss = {
      stop_price: params.stopLoss.stopPrice,
      limit_price: params.stopLoss.limitPrice,
      client_order_id: crypto.randomUUID(),
    };
  }

  if (params.builderCode) {
    payload.builder_code = params.builderCode;
  }

  await pacificSignedPost('/positions/tpsl', 'set_position_tpsl', payload, account, signMessage);
}

export async function requestWithdrawal(
  amountUsdc: number,
  account: string,
  signMessage: SignMessageFn,
): Promise<void> {
  await pacificSignedPost(
    '/account/withdraw',
    'withdraw',
    { amount: amountUsdc.toFixed(6) },
    account,
    signMessage,
    30000,
  );
}
