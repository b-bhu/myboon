/**
 * Mock gating for the Feed redesign prototype (issue #494).
 *
 * The flag reads process.env.EXPO_PUBLIC_FEED_MOCKS (literal form, so Expo inlines it) at module load, so values are baked in
 * at bundle time and only flip in development builds. Only the strings
 * "1", "true" and "on" (trimmed, case-insensitive) enable mocks.
 */
export const MOCK_ENV_KEY = 'EXPO_PUBLIC_FEED_MOCKS';

export function isFeedMocksEnabled(value: string | undefined): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'on';
}

export const FEED_MOCKS = isFeedMocksEnabled(process.env.EXPO_PUBLIC_FEED_MOCKS);

/** Keeps a mock value only when mocks are active; falls back to null otherwise. */
export function withMock<T>(value: T, enabled?: boolean): T | null {
  return (enabled ?? FEED_MOCKS) ? value : null;
}
