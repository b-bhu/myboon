/**
 * Email OTP resend timing for the connection sheet.
 *
 * `@privy-io/expo` `useLoginWithEmail().sendCode({ email })` is the resend
 * call. It resolves to `{ success: boolean }` and rejects with `PrivyApiError`
 * (`code: 'too_many_requests'`, HTTP 429) when the server refuses another code.
 * The published bucket is 5 email sends every 5 minutes — not the mock's
 * 30 second demo timer.
 *
 * https://docs.privy.io/authentication/user-authentication/login-methods/email
 * https://docs.privy.io/recipes/using-test-accounts
 */

export const PRIVY_EMAIL_SEND_LIMIT = 5;
/** Production apps: 5 email OTP requests every 5 minutes. */
export const PRIVY_EMAIL_SEND_WINDOW_MS = 5 * 60 * 1000;

export const OTP_RESEND_LABEL = 'Resend code';

export type OtpSendPhase = 'idle' | 'sending' | 'sent' | 'resent';

export interface OtpCodeSession {
  email: string;
  /** Absolute timestamps of sends Privy accepted. */
  sentAt: number[];
  /** Absolute ms when another send is allowed. 0 means now. */
  availableAt: number;
  phase: OtpSendPhase;
  /** Polite status. Announced when it changes, not every countdown tick. */
  status: string;
  error: string | null;
  /** A code was accepted by Privy for this email. */
  delivered: boolean;
}

export function emptyOtpSession(email = ''): OtpCodeSession {
  return {
    email: email.trim(),
    sentAt: [],
    availableAt: 0,
    phase: 'idle',
    status: '',
    error: null,
    delivered: false,
  };
}

export function sameOtpEmail(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

export function sessionForEmail(session: OtpCodeSession, email: string): OtpCodeSession {
  return sameOtpEmail(session.email, email) ? session : emptyOtpSession(email);
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    if (typeof record.error === 'string' && record.error.trim()) return record.error.trim();
    if (typeof record.message === 'string' && record.message.trim()) return record.message.trim();
  }
  return '';
}

/** A wait Privy actually attached to the failure. Nothing if it didn't. */
export function readRetryDelayMs(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const record = error as Record<string, unknown>;
  for (const key of ['retryAfterMs', 'retry_after_ms']) {
    const value = finiteNumber(record[key]);
    if (value !== null && value >= 0) return value;
  }
  for (const key of ['retryAfter', 'retry_after', 'retryAfterSeconds', 'retry_after_seconds']) {
    const value = finiteNumber(record[key]);
    if (value !== null && value >= 0) return value * 1000;
  }
  const headers = record.headers;
  if (headers && typeof headers === 'object') {
    const header = headers as Record<string, unknown>;
    const raw = header['retry-after'] ?? header['Retry-After'];
    const seconds = finiteNumber(raw);
    if (seconds !== null && seconds >= 0) return seconds * 1000;
  }
  const message = errorText(error);
  const match = message.match(
    /(\d+(?:\.\d+)?)\s*(milliseconds|millisecond|ms|seconds|second|secs|sec|minutes|minute|mins|min)\b/i,
  );
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit.startsWith('ms') || unit.startsWith('milli')) return amount;
  if (unit.startsWith('min')) return amount * 60_000;
  return amount * 1000;
}

export function isPrivyRateLimit(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as Record<string, unknown>;
  if (record.status === 429 || record.code === 'too_many_requests') return true;
  return /too many requests/i.test(errorText(error));
}

export function freshSends(sentAt: readonly number[], now: number): number[] {
  return sentAt.filter((sent) => now - sent < PRIVY_EMAIL_SEND_WINDOW_MS).sort((a, b) => a - b);
}

/**
 * When the next send fits in Privy's 5-per-5-minutes bucket. 0 means it fits now.
 * The deadline is the oldest counted send plus the window, so it does not move
 * just because the screen was opened again.
 */
export function nextSendAt(sentAt: readonly number[], now: number): number {
  const fresh = freshSends(sentAt, now);
  if (fresh.length < PRIVY_EMAIL_SEND_LIMIT) return 0;
  return fresh[0] + PRIVY_EMAIL_SEND_WINDOW_MS;
}

export function canRequestOtp(session: OtpCodeSession, now: number): boolean {
  return session.phase !== 'sending' && now >= session.availableAt;
}

export function resendButtonLabel(availableAt: number, now: number): string {
  const remaining = Math.max(0, Math.ceil((availableAt - now) / 1000));
  if (remaining <= 0) return OTP_RESEND_LABEL;
  if (remaining < 60) return `${OTP_RESEND_LABEL} · ${remaining}s`;
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  return `${OTP_RESEND_LABEL} · ${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/** Start a send. Null means a tap landed during sending or before the deadline. */
export function beginOtpSend(session: OtpCodeSession, email: string, now: number): OtpCodeSession | null {
  const next = sessionForEmail(session, email);
  if (!canRequestOtp(next, now)) return null;
  return {
    ...next,
    email: email.trim(),
    phase: 'sending',
    status: next.delivered ? 'Resending code…' : 'Sending code…',
    error: null,
  };
}

export function finishOtpSend(
  session: OtpCodeSession,
  now: number,
  outcome: { ok: true } | { ok: false; error: unknown },
): OtpCodeSession {
  if (session.phase !== 'sending') return session;
  if (outcome.ok) {
    const sentAt = [...freshSends(session.sentAt, now), now];
    return {
      ...session,
      sentAt,
      availableAt: nextSendAt(sentAt, now),
      delivered: true,
      phase: session.delivered ? 'resent' : 'sent',
      status: session.delivered ? 'Code resent.' : 'Code sent.',
      error: null,
    };
  }
  const rateLimited = isPrivyRateLimit(outcome.error);
  const message = errorText(outcome.error) || (
    rateLimited ? 'Too many requests. Please wait to try again.' : 'Could not send the code.'
  );
  let availableAt = session.availableAt;
  if (rateLimited) {
    const hinted = readRetryDelayMs(outcome.error);
    const fromServer = hinted === null ? now + PRIVY_EMAIL_SEND_WINDOW_MS : now + hinted;
    availableAt = Math.max(session.availableAt, nextSendAt(session.sentAt, now), fromServer);
  }
  return {
    ...session,
    availableAt,
    phase: session.delivered ? 'sent' : 'idle',
    status: message,
    error: message,
  };
}
