/**
 * chain.debug — visibility into how an EVM requirement resolves.
 *
 * The connectivity layer answers "can this user sign on Polygon?" through four
 * hooks and a persisted record, and when the answer is wrong the failure is
 * silent: a screen renders "Connect wallet" and nothing says which stage
 * decided that. Diagnosing it from the UI alone means guessing.
 *
 * These logs name the stage and its inputs, so a device build shows where the
 * chain breaks rather than only that it broke.
 *
 * Deliberately deduplicated: `usePrivyEvmWallet` re-renders on every Privy
 * state change and is mounted by four consumers at once, so logging
 * unconditionally buries the transitions that matter under hundreds of
 * identical lines. Only changes are printed.
 */

const lastByScope = new Map<string, string>();

/** Log `payload` under `scope`, but only when it differs from the last one. */
export function logChainState(scope: string, payload: Record<string, unknown>): void {
  // Stripped from production bundles — this is a development aid, and the
  // payload names wallet addresses that need not appear in release logs.
  if (!__DEV__) return;

  let serialised: string;
  try {
    serialised = JSON.stringify(payload);
  } catch {
    return;
  }

  if (lastByScope.get(scope) === serialised) return;
  lastByScope.set(scope, serialised);
  console.log(`[chain:${scope}]`, serialised);
}

/**
 * Log an event that matters every time it happens — a provision attempt, a
 * failure — rather than only on change.
 */
export function logChainEvent(scope: string, event: string, payload?: Record<string, unknown>): void {
  if (!__DEV__) return;
  if (payload) console.log(`[chain:${scope}] ${event}`, JSON.stringify(payload));
  else console.log(`[chain:${scope}] ${event}`);
}
