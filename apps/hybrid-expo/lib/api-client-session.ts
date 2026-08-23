// Per-process abuse-control identity. It contains no wallet or user material,
// and intentionally rotates when the app process restarts.
// Create it lazily: Expo web evaluates modules during server rendering, where
// browser-only crypto implementations may try to read `window` and crash the
// bundle before any request is made.
let clientSessionId: string | null = null;

function createClientSessionId(): string {
  const runtimeCrypto = (globalThis as {
    crypto?: { randomUUID?: () => string; getRandomValues?: (values: Uint32Array) => Uint32Array };
  }).crypto;

  if (typeof runtimeCrypto?.randomUUID === 'function') {
    return runtimeCrypto.randomUUID();
  }

  if (typeof runtimeCrypto?.getRandomValues === 'function') {
    const values = runtimeCrypto.getRandomValues(new Uint32Array(4));
    return `runtime-${Array.from(values, (value) => value.toString(36)).join('-')}`;
  }

  // This identifier is only a rate-budget bucket, not a credential or signing
  // nonce. A timestamp/random fallback keeps SSR and older runtimes usable.
  return `runtime-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function apiClientSessionHeaders(): Record<string, string> {
  clientSessionId ??= createClientSessionId();
  return {
    'x-myboon-client': 'hybrid-expo-v1',
    'x-myboon-session': clientSessionId,
  };
}
