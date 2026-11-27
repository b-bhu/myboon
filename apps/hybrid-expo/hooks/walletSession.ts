/**
 * Shared external (Mobile Wallet Adapter) session state for `useWallet` on
 * native.
 *
 * The disconnect flag used to live in per-hook `useState`, so every
 * `useWallet()` consumer kept its own copy: a disconnect on the connection
 * sheet was invisible on Home, and the next email/Google login could still
 * select the stale external account from another screen. One module-level
 * store shared by all consumers fixes that (#947) — `useWallet.native.ts`
 * reads it through `useSyncExternalStore`, so every subscriber re-renders
 * when the shared flag flips.
 *
 * The adapter address read is kept safe here too: a missing, non-string, or
 * unsafe `account.address` is treated as "no external address" instead of
 * throwing into the error screen.
 */

export type WalletSource = 'privy' | 'mwa';

type Listener = () => void;

const listeners = new Set<Listener>();
let mwaAccountCleared = false;

function emit(): void {
  listeners.forEach((listener) => listener());
}

export function subscribeMwaAccountCleared(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getMwaAccountCleared(): boolean {
  return mwaAccountCleared;
}

/** The external session was cleared by any screen — every consumer sees it. */
export function clearMwaAccount(): void {
  if (mwaAccountCleared) return;
  mwaAccountCleared = true;
  emit();
}

/** The user re-connected the external wallet; the shared clear is withdrawn. */
export function restoreMwaAccount(): void {
  if (!mwaAccountCleared) return;
  mwaAccountCleared = false;
  emit();
}

/** Test seam: reset the shared session between test cases. */
export function resetMwaSessionForTests(): void {
  mwaAccountCleared = false;
  emit();
}

/**
 * Reading `account?.address` has thrown for unsafe values before (#947): a
 * missing or non-string value, or one whose `toBase58` is not callable or
 * does not return a string, is no external address.
 */
export function readMwaAddress(account: { address?: unknown } | null | undefined): string | null {
  const raw = account?.address;
  if (typeof raw === 'string') return raw || null;
  if (raw && typeof (raw as { toBase58?: unknown }).toBase58 === 'function') {
    try {
      const base58 = (raw as { toBase58: () => unknown }).toBase58();
      return typeof base58 === 'string' && base58 ? base58 : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The single decision behind `useWallet.native`'s two return branches: an
 * external wallet deliberately connected wins over a signed-in Privy session
 * once Privy has settled, unless the shared disconnect cleared it — then the
 * Privy (email/Google) wallet is selected, never the stale external account.
 */
export type WalletSessionInput = {
  /** Shared, cross-screen disconnect flag. */
  mwaAccountCleared: boolean;
  /** Safe read of the adapter address (`readMwaAddress`), before the cleared gate. */
  mwaAddress: string | null;
  privyIsPrivyUser: boolean;
  privyIsPreparing: boolean;
  /**
   * The Privy session was signed in with the external wallet (SIWS, #948).
   * That account never receives an embedded Solana wallet — `createOnLogin`
   * is 'off' and nothing creates one for it — so its "preparing" state is
   * permanent by design and must not be waited out.
   */
  privyWalletLogin: boolean;
  privyConnected: boolean;
  privyAddress: string | null;
};

export type WalletSessionPick = {
  source: WalletSource;
  address: string | null;
};

export function pickWalletSession(input: WalletSessionInput): WalletSessionPick {
  const mwaAddress = input.mwaAccountCleared ? null : input.mwaAddress;
  // For a wallet-login account (#948) "no embedded wallet yet" never resolves:
  // the external wallet is the main Solana account the moment it is there.
  // An email/Google account keeps the hydration guard — its embedded wallet
  // does arrive, and a stale cached external account must not leak meanwhile.
  const settledForSolana = !input.privyIsPreparing || input.privyWalletLogin;
  const preferMwa = !!mwaAddress && settledForSolana;
  if (input.privyIsPrivyUser && !preferMwa) {
    return { source: 'privy', address: input.privyConnected ? input.privyAddress : null };
  }
  return { source: 'mwa', address: mwaAddress };
}
