/**
 * #478: the V4 analyst foundation -- per-signal states, time-limited claims,
 * the sweeper, retry/dead-letter, and the logged Jev client, all backed by
 * the atlas.signal_* SQL functions. The acceptance tests
 * (signal-states.db.test.ts) drive exactly this API against a throwaway
 * local database. TypeSafeJev is the real-Jev JevPort implementation
 * (#485), with the recorded-fixture replay for offline verification.
 */
export * from './states.js';
export * from './jev.js';
export * from './typesafe-jev.js';
export * from './stage.js';
// #479 test-first stub; implementation follows.
export async function runAnalystOnce(_pool: import('pg').Pool, _o: { jev: import('./jev.js').JevPort; limit: number; leaseMs: number; backoffMs: number; timeoutMs: number }): Promise<unknown> {
  throw new Error('not implemented (#479)');
}
