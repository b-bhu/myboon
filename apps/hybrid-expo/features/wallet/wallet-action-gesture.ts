/**
 * Wallet action names are intentionally separate from the swap screen's
 * entry modes.  Send, Receive, and Transfer are menu affordances even when
 * their execution flows are unavailable.
 */
export type WalletAction = 'swap' | 'send' | 'receive' | 'transfer';

export const WALLET_ACTION_MENU_IDS = [
  'swap',
  'send',
  'receive',
  'transfer',
] as const satisfies readonly WalletAction[];

export type WalletActionMenuId = (typeof WALLET_ACTION_MENU_IDS)[number];

export const WALLET_ACTION_MENU = [
  { id: 'swap', label: 'Swap' },
  { id: 'send', label: 'Send' },
  { id: 'receive', label: 'Receive' },
  { id: 'transfer', label: 'Transfer' },
] as const satisfies readonly { id: WalletActionMenuId; label: string }[];

export interface WalletGestureScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ReverseGestureHandlers {
  onSingleTap: () => void;
  onDoubleTap: () => void;
}

export interface ReverseGestureOptions extends Partial<ReverseGestureHandlers> {
  /** The tap resolution window. The product default is 300ms. */
  windowMs?: number;
  /** Alias accepted for callers that describe this as the double-tap delay. */
  delayMs?: number;
  /** Checked synchronously both when a tap arrives and when a single resolves. */
  isEnabled?: () => boolean;
  /** Alias for isEnabled. */
  enabled?: () => boolean;
  scheduler?: WalletGestureScheduler;
}

export interface ReverseGestureController extends ReverseGestureHandlers {
  /** Feed one completed press into the exclusive single/double recognizer. */
  handleTap(): void;
  /** Cancel a pending single tap and reset the double-tap window. */
  cancel(): void;
  /** Cancel pending work permanently, for example when the owner unmounts. */
  dispose(): void;
  /** Replace callbacks/predicate without replacing the recognizer. */
  update(next: Partial<ReverseGestureOptions>): void;
}

const DEFAULT_WINDOW_MS = 300;

const systemScheduler: WalletGestureScheduler = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Create an exclusive Reverse recognizer.
 *
 * A first press is held for one window so it can still become a double tap.
 * A second press in that window cancels the held single and invokes the
 * double callback immediately.  The owner should call cancel when another
 * surface/session starts or when the reverse control becomes busy.
 *
 * The mutable handlers and predicate are deliberately read at dispatch time.
 * Callers can therefore keep this controller stable and update it from their
 * latest render, avoiding callbacks that close over an old Wallet draft.
 */
export function createReverseGesture(
  options: ReverseGestureOptions = {},
): ReverseGestureController {
  let handlers: ReverseGestureHandlers = {
    onSingleTap: options.onSingleTap ?? (() => {}),
    onDoubleTap: options.onDoubleTap ?? (() => {}),
  };
  let enabled = options.isEnabled ?? options.enabled ?? (() => true);
  const scheduler = options.scheduler ?? systemScheduler;
  const windowMs = options.windowMs ?? options.delayMs ?? DEFAULT_WINDOW_MS;

  let pendingTimer: unknown;
  let disposed = false;

  const cancel = (): void => {
    if (pendingTimer !== undefined) {
      scheduler.clearTimeout(pendingTimer);
      pendingTimer = undefined;
    }
  };

  const invokeIfEnabled = (callback: () => void): void => {
    // This predicate is intentionally synchronous.  A timeout that fires just
    // after a busy/session/unmount transition must not mutate the draft.
    if (!disposed && enabled()) callback();
  };

  const handleTap = (): void => {
    if (disposed || !enabled()) {
      cancel();
      return;
    }

    if (pendingTimer !== undefined) {
      cancel();
      invokeIfEnabled(handlers.onDoubleTap);
      return;
    }

    pendingTimer = scheduler.setTimeout(() => {
      // Clear before invoking user code so a callback that causes another tap
      // starts a fresh window rather than interacting with this one.
      pendingTimer = undefined;
      invokeIfEnabled(handlers.onSingleTap);
    }, windowMs);
  };

  const update = (next: Partial<ReverseGestureOptions>): void => {
    if (next.onSingleTap !== undefined) handlers.onSingleTap = next.onSingleTap;
    if (next.onDoubleTap !== undefined) handlers.onDoubleTap = next.onDoubleTap;
    if (next.isEnabled !== undefined) enabled = next.isEnabled;
    else if (next.enabled !== undefined) enabled = next.enabled;
  };

  const dispose = (): void => {
    if (disposed) return;
    cancel();
    disposed = true;
  };

  return {
    get onSingleTap() {
      return handlers.onSingleTap;
    },
    get onDoubleTap() {
      return handlers.onDoubleTap;
    },
    handleTap,
    cancel,
    dispose,
    update,
  };
}

/** More explicit alias for callers wiring a Wallet action control. */
export const createWalletActionGesture = createReverseGesture;
