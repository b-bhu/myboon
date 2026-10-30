/**
 * Mock gating for the Feed redesign prototype (issue #494).
 *
 * The flag reads EXPO_PUBLIC_FEED_MOCKS at module load, so values are baked in
 * at bundle time and only flip in development builds. Only the strings
 * "1", "true" and "on" (trimmed, case-insensitive) enable mocks.
 */
export const MOCK_ENV_KEY = 'EXPO_PUBLIC_FEED_MOCKS';

export const STORY_ACTIVE_DAYS = 7;

export function isFeedMocksEnabled(value: string | undefined): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'on';
}

export const FEED_MOCKS = isFeedMocksEnabled(process.env[MOCK_ENV_KEY]);

/** A story stays active for STORY_ACTIVE_DAYS. Invalid dates are never active. */
export function isStoryActive(updatedAt: string, now: Date = new Date()): boolean {
  const updatedAtMs = Date.parse(updatedAt);
  if (Number.isNaN(updatedAtMs)) return false;
  const ageMs = now.getTime() - updatedAtMs;
  return ageMs < STORY_ACTIVE_DAYS * 24 * 60 * 60 * 1000;
}

/** Keeps a mock value only when mocks are active; falls back to null otherwise. */
export function withMock<T>(value: T, enabled?: boolean): T | null {
  return (enabled ?? FEED_MOCKS) ? value : null;
}