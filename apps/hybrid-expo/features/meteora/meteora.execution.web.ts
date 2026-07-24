import type { MeteoraPendingStorage } from './meteora.pending';

/**
 * Web execution controller.
 *
 * The engine in `meteora.execution.native.ts` is plain Solana/web3.js logic
 * with no React Native dependency except its `AsyncStorage`-backed pending
 * storage, which is already an injectable `pendingStorage` option. Re-export
 * that same engine here and swap in a browser-storage backend so web (via a
 * connected browser wallet, e.g. Phantom) can build, simulate, sign, submit,
 * and recover Meteora transactions exactly like native does. This exists for
 * local testing — myBoon does not ship Meteora execution as a web product
 * feature (see meteora.form-execution.web.ts).
 */
export * from './meteora.execution.native';

export function createWebMeteoraPendingStorage(): MeteoraPendingStorage {
  return {
    async getItem(key) {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    async setItem(key, value) {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        // Best-effort only — a private-browsing quota error must never break
        // a submission that has already reached the network.
      }
    },
    async removeItem(key) {
      try {
        window.localStorage.removeItem(key);
      } catch {
        // Ignore — see setItem.
      }
    },
  };
}
