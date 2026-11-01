import { fetchWithTimeout, resolveApiBaseUrl } from '@/lib/api';
import { WAITLIST_SOURCE } from '@/features/waitlist/waitlist.mode';

/**
 * Waitlist client for `POST {API_BASE}/waitlist` (contract on #432):
 * 201 { ok: true } for new and repeat emails, 400 invalid_email | invalid_x_handle,
 * 429 rate_limited.
 */
export interface WaitlistRequest {
  email: string;
  xHandle?: string;
  source: string;
}

export type WaitlistErrorCode =
  | 'invalid_email'
  | 'invalid_x_handle'
  | 'rate_limited'
  | 'offline'
  | 'server_error';

export type WaitlistResult = { ok: true } | { ok: false; code: WaitlistErrorCode };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const X_HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Strips whitespace and one leading "@"; returns '' when nothing was typed. */
export function normalizeXHandle(raw: string): string {
  return raw.trim().replace(/^@/, '');
}

export function validateEmail(raw: string): boolean {
  const email = normalizeEmail(raw);
  return email.length <= 254 && EMAIL_RE.test(email);
}

/** Empty is valid: the X handle is optional. */
export function validateXHandle(raw: string): boolean {
  const handle = normalizeXHandle(raw);
  return handle === '' || X_HANDLE_RE.test(handle);
}

export function buildWaitlistRequest(email: string, xHandle: string): WaitlistRequest {
  const handle = normalizeXHandle(xHandle);
  return {
    email: normalizeEmail(email),
    ...(handle ? { xHandle: handle } : {}),
    source: WAITLIST_SOURCE,
  };
}

export const WAITLIST_ERROR_COPY: Record<WaitlistErrorCode, string> = {
  invalid_email: 'Enter a valid email address.',
  invalid_x_handle: 'X handles are up to 15 letters, numbers or underscores.',
  rate_limited: 'Too many attempts. Please try again in a few minutes.',
  offline: "You're offline. Check your connection and try again.",
  server_error: 'Something went wrong. Please try again.',
};

export async function joinWaitlist(
  email: string,
  xHandle: string,
  fetchImpl: typeof fetchWithTimeout = fetchWithTimeout,
): Promise<WaitlistResult> {
  if (!validateEmail(email)) return { ok: false, code: 'invalid_email' };
  if (!validateXHandle(xHandle)) return { ok: false, code: 'invalid_x_handle' };

  let response: Response;
  try {
    response = await fetchImpl(`${resolveApiBaseUrl()}/waitlist`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(buildWaitlistRequest(email, xHandle)),
    });
  } catch {
    return { ok: false, code: 'offline' };
  }

  if (response.status === 200 || response.status === 201) return { ok: true };
  if (response.status === 429) return { ok: false, code: 'rate_limited' };
  if (response.status === 400) {
    const body = await response.json().catch(() => null) as { error?: unknown } | null;
    if (body?.error === 'invalid_x_handle') return { ok: false, code: 'invalid_x_handle' };
    return { ok: false, code: 'invalid_email' };
  }
  return { ok: false, code: 'server_error' };
}
