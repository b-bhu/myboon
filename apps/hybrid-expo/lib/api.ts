/**
 * Resolve the API base URL.
 *
 * Local Expo starts load localhost from .env. EAS preview and production builds
 * supply the hosted URL from their build profiles. On Android, the start script
 * forwards the device's localhost:3000 to the development machine with ADB.
 */
export function resolveApiBaseUrl(): string {
  const fromEnv = process.env.EXPO_PUBLIC_API_BASE_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, '');

  return 'http://localhost:3000';
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
