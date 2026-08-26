export type PredictErrorKind =
  | 'authentication'
  | 'user_rejected'
  | 'insufficient_balance'
  | 'liquidity'
  | 'order_rejected'
  | 'order_waiting'
  | 'relayer'
  | 'bridge'
  | 'redemption'
  | 'network'
  | 'unknown';

export interface NormalizedPredictError {
  kind: PredictErrorKind;
  code: string;
  message: string;
  retryable: boolean;
}

function errorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    return [error.name, error.message, cause ? errorText(cause) : ''].filter(Boolean).join(' ');
  }
  if (error && typeof error === 'object') {
    const value = error as Record<string, unknown>;
    return [value.name, value.code, value.message, value.detail, value.error]
      .filter((part): part is string => typeof part === 'string')
      .join(' ');
  }
  return String(error ?? '');
}

function statusFrom(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const value = error as Record<string, unknown>;
  if (typeof value.status === 'number') return value.status;
  const response = value.response;
  return response && typeof response === 'object' && typeof (response as Record<string, unknown>).status === 'number'
    ? (response as Record<string, number>).status
    : null;
}

/** Convert SDK, proxy and bridge failures into stable user-facing categories. */
export function normalizePredictError(error: unknown, fallback = 'Predict action failed.'): NormalizedPredictError {
  const raw = errorText(error);
  const text = raw.toLowerCase();
  const status = statusFrom(error);

  if (/user rejected|request rejected by user|cancelled signing|denied signature|4001/u.test(text)) {
    return { kind: 'user_rejected', code: 'USER_REJECTED', message: 'Signature cancelled.', retryable: true };
  }
  if (/insufficient.+balance|insufficient_balance|balance or allowance|not enough (cash|funds)|allowance/u.test(text)) {
    return { kind: 'insufficient_balance', code: 'INSUFFICIENT_BALANCE', message: 'Not enough available balance or allowance.', retryable: false };
  }
  if (/fok|fak|not filled|unmatched|liquidity/u.test(text)) {
    return { kind: 'liquidity', code: 'NOT_FILLED', message: 'Not filled. Price or liquidity changed. Try a smaller amount.', retryable: true };
  }
  if (/waiting|delayed|pending settlement/u.test(text)) {
    return { kind: 'order_waiting', code: 'ORDER_WAITING', message: 'Order submitted and waiting to match.', retryable: false };
  }
  if (/post.only|invalid_(nonce|expiration)|order rejected|market.not.ready/u.test(text)) {
    return { kind: 'order_rejected', code: 'ORDER_REJECTED', message: raw || 'Polymarket rejected the order.', retryable: true };
  }
  if (/redeem|redemption|position.+resolved/u.test(text)) {
    return { kind: 'redemption', code: 'REDEMPTION_FAILED', message: raw || 'Could not redeem this position.', retryable: true };
  }
  if (/bridge|withdraw route|deposit address/u.test(text)) {
    return { kind: 'bridge', code: 'BRIDGE_FAILED', message: raw || 'The bridge request failed.', retryable: true };
  }
  if (/relayer|gasless|transaction failed|transaction.+reverted/u.test(text)) {
    return { kind: 'relayer', code: 'RELAYER_FAILED', message: raw || 'The Polymarket transaction failed.', retryable: true };
  }
  if (status === 401 || status === 403 || /auth|api.?key|credential|builder.auth/u.test(text)) {
    return { kind: 'authentication', code: 'AUTH_FAILED', message: 'Predict authentication failed. Reconnect and try again.', retryable: true };
  }
  if (
    (status !== null && (status === 408 || status === 429 || status >= 500))
    || /network|fetch failed|timeout|timed out|transport|non-json|proxy/u.test(text)
  ) {
    return { kind: 'network', code: 'NETWORK_FAILED', message: 'Predict is temporarily unreachable. Try again.', retryable: true };
  }
  return { kind: 'unknown', code: 'PREDICT_FAILED', message: raw || fallback, retryable: true };
}

