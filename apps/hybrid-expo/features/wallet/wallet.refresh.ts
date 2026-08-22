type WalletRefreshListener = () => void;

const listeners = new Set<WalletRefreshListener>();

/**
 * Process-local invalidation signal for confirmed wallet mutations.
 * It carries no wallet address or transaction data; mounted wallet surfaces
 * re-read their own active address through their existing data clients.
 */
export function notifyWalletDataChanged(): void {
  for (const listener of listeners) {
    try { listener(); } catch { /* Refresh listeners never change trade truth. */ }
  }
}

export function subscribeWalletDataChanged(listener: WalletRefreshListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
