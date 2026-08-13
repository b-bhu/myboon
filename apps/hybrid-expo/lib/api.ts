import { Platform } from 'react-native';

/** Local API host, accounting for the Android emulator's loopback alias. */
function localApiBaseUrl(): string {
  return Platform.OS === 'android' ? 'http://10.0.2.2:3000' : 'http://localhost:3000';
}

/**
 * Resolve the API base URL.
 *
 * `EXPO_PUBLIC_API_ENV` is the switch:
 *   local       -> always the local dev server, ignoring any configured URL
 *   production  -> EXPO_PUBLIC_API_BASE_URL (the deployed API)
 *   unset       -> EXPO_PUBLIC_API_BASE_URL if set, else local
 *
 * The explicit `local` mode exists because EXPO_PUBLIC_API_BASE_URL is normally
 * pinned to the deployed API in .env, which silently wins over the localhost
 * fallback — so pointing the app at a local server used to mean editing (and
 * remembering to restore) that value. Flip EXPO_PUBLIC_API_ENV instead.
 *
 * Single source of truth — replaces the 4 copies across the codebase.
 */
export function resolveApiBaseUrl(): string {
  const mode = process.env.EXPO_PUBLIC_API_ENV?.trim().toLowerCase();
  if (mode === 'local') return localApiBaseUrl();

  const fromEnv = process.env.EXPO_PUBLIC_API_BASE_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, '');

  return localApiBaseUrl();
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Fetch wrapper with a default 15 s timeout via AbortController.
 * Drop-in replacement for global fetch — same signature, just adds timeout.
 */
export function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit & { timeoutMs?: number },
): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...fetchInit } = init ?? {};

  const controller = new AbortController();
  // Respect an existing signal by forwarding abort
  if (fetchInit.signal) {
    fetchInit.signal.addEventListener('abort', () => controller.abort());
  }

  const timer = setTimeout(() => controller.abort(), timeoutMs);

  return fetch(input, { ...fetchInit, signal: controller.signal }).finally(() =>
    clearTimeout(timer),
  );
}
