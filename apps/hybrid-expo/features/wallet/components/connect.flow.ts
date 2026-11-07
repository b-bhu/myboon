/**
 * connect.flow — the connection sheet's step machine.
 *
 * Kept apart from `ConnectionSheet.tsx` so login vs wallet setup, the
 * already-have path, and the export entry can be tested without React Native.
 *
 * The sheet is a staged choice, not a flat list: create (email / Google →
 * Privy) or already-have (Seeker / Phantom → Mobile Wallet Adapter). The
 * already-have events never mark the session as Privy and never count as a
 * wallet-setup failure. That is what stops a cancelled external connect from
 * being retried as `waitForWallet()` / `create()`.
 *
 * Model: docs/mockups/wallet-connect/NOTES.md and issue #316 (folded into #590).
 */

export type ExternalWalletChoice = 'seeker' | 'phantom';

export type LinkedKind = 'privy' | 'external';

export type WalletSetupFailure = 'timeout' | 'create';

export type ConnectStep =
  | { kind: 'choice' }
  | { kind: 'create' }
  | { kind: 'email' }
  | { kind: 'otp' }
  | { kind: 'signing_in' }
  | { kind: 'creating' }
  | { kind: 'have' }
  | { kind: 'connecting_external'; wallet: ExternalWalletChoice }
  | { kind: 'fail_login' }
  | { kind: 'fail_setup' }
  | { kind: 'connected' }
  | { kind: 'export' }
  | { kind: 'export_opening' }
  | { kind: 'export_failed' }
  | { kind: 'confirm_disconnect' };

export interface ConnectFlowState {
  step: ConnectStep;
  history: ConnectStep[];
  /** Wallet-setup failures since the last successful setup or sign-out. */
  setupAttempts: number;
  /** Signed in, and the requested wallet is not ready. Survives closing the sheet. */
  setupOutstanding: boolean;
  setupFailure: WalletSetupFailure | null;
  linked: LinkedKind | null;
  externalWallet: ExternalWalletChoice | null;
  externalError: string | null;
}

export type ConnectFlowEvent =
  | {
      type: 'open';
      linked: LinkedKind | null;
      privyAuthenticated: boolean;
      /** A Privy embedded wallet already exists on some chain. */
      hasEmbeddedWallet: boolean;
    }
  | { type: 'back' }
  | { type: 'choose_create' }
  | { type: 'choose_have' }
  | { type: 'choose_email' }
  | { type: 'code_sent' }
  | { type: 'otp_rejected' }
  | { type: 'start_google' }
  | { type: 'login_cancelled' }
  | { type: 'login_failed' }
  | { type: 'login_succeeded' }
  | { type: 'retry_login' }
  | { type: 'wallet_setup_failed'; failure: WalletSetupFailure }
  | { type: 'wallet_setup_succeeded'; linked: LinkedKind }
  | { type: 'retry_wallet' }
  | { type: 'logout' }
  | { type: 'choose_external'; wallet: ExternalWalletChoice }
  | { type: 'external_cancelled' }
  | { type: 'external_failed'; message: string }
  | { type: 'open_export' }
  | { type: 'export_not_now' }
  | { type: 'export_continue' }
  | { type: 'export_handed_off' }
  | { type: 'export_failed' }
  | { type: 'export_retry' }
  | { type: 'request_disconnect' }
  | { type: 'cancel_disconnect' }
  | { type: 'disconnected' };

/**
 * User-facing strings for the sheet. Tests lock these so a login failure and a
 * wallet-setup failure cannot collapse back into one "Invalid code".
 */
export const CONNECT_COPY = {
  invalidCode: 'Invalid code',
  retryWallet: 'Try wallet again',
  logoutAndRestart: 'Log out and start over',
  trySignInAgain: 'Try again',
  createWallet: 'Create a new wallet',
  alreadyHave: 'I already have a wallet',
  continueEmail: 'Continue with email',
  emailHint: 'One-time code',
  continueGoogle: 'Continue with Google',
  googleHint: 'Uses your Google account',
  seeker: 'Seeker',
  seekerHint: 'Solana Mobile',
  phantom: 'Phantom',
  phantomHint: 'Mobile Wallet Adapter',
  export: 'Export / recovery',
  exportWarning: 'Anyone with this key controls the funds. MyBoon never sees it.',
  continuePrivy: 'Continue with Privy',
  notNow: 'Not now',
  exportTryAgain: 'Try again',
  disconnect: 'Disconnect',
  cancel: 'Cancel',
  backToWallet: 'Back to wallet',
  copy: 'Copy',
  copied: 'Copied',
  sendCode: 'Send code',
  verify: 'Verify',
  paste: 'Paste',
  signInFailedTitle: 'Sign-in failed',
  signInFailedBody: "Couldn't verify email or Google.",
  setupFailedTitle: 'Wallet setup failed',
  finishSetupTitle: 'Finish wallet setup',
  setupFailedLead: "You're signed in, but the wallet didn't finish connecting.",
  setupTimeoutDetail: 'The wallet is still preparing.',
  setupCreateDetail: "The wallet couldn't be created.",
  finishSetupBody: "You're signed in. Finish connecting the wallet.",
  exportIntro: 'Opens Privy so you can export or recover this wallet. Sign in there if Privy asks.',
  exportFailed: "Couldn't open Privy. Nothing was exported.",
  creatingTitle: 'Creating your wallet',
  creatingBody: 'This only takes a moment.',
  signingInBody: 'Waiting for Google.',
  approveTitle: 'Approve in your wallet',
  openingPrivyTitle: 'Opening Privy',
  openingPrivyBody: 'Complete export or recovery there.',
  disconnectTitle: 'Disconnect this wallet?',
  disconnectBody: "You'll need to connect again to trade.",
  privyDisconnectBody:
    'This signs you out and disconnects every MyBoon wallet in this session. You can sign back in anytime.',
} as const;

/** Logout appears on the third wallet-setup failure, matching the approved mock. */
export const WALLET_SETUP_LOGOUT_AFTER = 3;

export const EXTERNAL_WALLET_CHOICES: readonly {
  id: ExternalWalletChoice;
  name: string;
  detail: string;
}[] = [
  { id: 'seeker', name: CONNECT_COPY.seeker, detail: CONNECT_COPY.seekerHint },
  { id: 'phantom', name: CONNECT_COPY.phantom, detail: CONNECT_COPY.phantomHint },
];

const BACK_STEPS = new Set<ConnectStep['kind']>([
  'create',
  'email',
  'otp',
  'have',
  'export',
  'export_failed',
]);

export const INITIAL_CONNECT_FLOW: ConnectFlowState = {
  step: { kind: 'choice' },
  history: [],
  setupAttempts: 0,
  setupOutstanding: false,
  setupFailure: null,
  linked: null,
  externalWallet: null,
  externalError: null,
};

export function canGoBack(state: ConnectFlowState): boolean {
  return state.history.length > 0 && BACK_STEPS.has(state.step.kind);
}

export function showsLogout(state: ConnectFlowState): boolean {
  return state.step.kind === 'fail_setup' && state.setupAttempts >= WALLET_SETUP_LOGOUT_AFTER;
}

export function connectedTitle(linked: LinkedKind): 'Wallets' | 'Wallet' {
  return linked === 'privy' ? 'Wallets' : 'Wallet';
}

/** Connected-sheet chain label. EVM, not Polygon. */
export function connectedChainLabel(chain: 'solana' | 'evm'): 'Solana' | 'EVM' {
  return chain === 'evm' ? 'EVM' : 'Solana';
}

export function choiceSubtitle(externalAvailable: boolean): string {
  return externalAvailable
    ? 'Create a MyBoon wallet or use one you already have.'
    : 'Create a MyBoon wallet with email or Google.';
}

export function sheetChrome(
  state: ConnectFlowState,
  options: { email?: string; externalAvailable: boolean },
): { title: string; subtitle: string } {
  switch (state.step.kind) {
    case 'choice':
      return { title: 'Connect', subtitle: choiceSubtitle(options.externalAvailable) };
    case 'create':
      return { title: 'Create a wallet', subtitle: 'Continue with email or Google.' };
    case 'email':
      return { title: 'Email', subtitle: "We'll send a one-time code." };
    case 'otp':
      return {
        title: 'Enter code',
        subtitle: options.email ? `Sent to ${options.email}` : 'Enter the code you were sent.',
      };
    case 'signing_in':
      return { title: 'Signing in', subtitle: '' };
    case 'creating':
      return { title: 'Creating wallet', subtitle: '' };
    case 'have':
      return { title: 'Connect a wallet', subtitle: 'Seeker or Phantom via Solana Mobile.' };
    case 'connecting_external':
      return { title: 'Waiting for wallet', subtitle: '' };
    case 'fail_login':
      return { title: CONNECT_COPY.signInFailedTitle, subtitle: '' };
    case 'fail_setup':
      return {
        title: state.setupFailure ? CONNECT_COPY.setupFailedTitle : CONNECT_COPY.finishSetupTitle,
        subtitle: '',
      };
    case 'connected':
      return { title: state.linked === 'external' ? 'Wallet' : 'Wallets', subtitle: '' };
    case 'export':
      return { title: CONNECT_COPY.export, subtitle: 'Recover your MyBoon wallet with Privy.' };
    case 'export_opening':
      return { title: 'Privy', subtitle: '' };
    case 'export_failed':
      return { title: CONNECT_COPY.export, subtitle: '' };
    case 'confirm_disconnect':
      return { title: 'Disconnect?', subtitle: 'You can reconnect anytime.' };
    default: {
      const _exhaustive: never = state.step;
      return _exhaustive;
    }
  }
}

export function externalWaitingLabel(wallet: ExternalWalletChoice): string {
  return wallet === 'phantom' ? CONNECT_COPY.phantom : CONNECT_COPY.seeker;
}

/**
 * Wallet-adapter cancellation. Message text is the only signal those libraries
 * give — there is no error code. Anything else is a real failure.
 */
export function isUserCancelled(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /plugin closed|user rejected|user denied|request rejected|cancell?ed/i.test(message);
}

/**
 * Login already succeeded. Split the timeout (waitForWallet's 15s) from a
 * create()/provision() throw so the sheet can say which one happened.
 */
export function classifyWalletSetupError(error: unknown): WalletSetupFailure {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (/still preparing|timed out|timeout/i.test(message)) return 'timeout';
  return 'create';
}

export function otpFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : '';
  return message || CONNECT_COPY.invalidCode;
}

/**
 * Already-have is Mobile Wallet Adapter only. The name is a hint for web,
 * where an extension can be selected. Native MWA opens the system chooser
 * either way — it cannot pre-select Seeker or Phantom — and must not create
 * a Privy wallet to "fill in" that gap.
 */
export function externalConnectBackend(): 'external_mwa' {
  return 'external_mwa';
}

/**
 * Privy Home. Users re-authenticate there and export from Privy's page.
 * https://docs.privy.io/basics/get-started/dashboard/privy-home
 *
 * No query, hash, or user data. The app must not attach an address or token.
 */
export const PRIVY_HOME_URL = 'https://home.privy.io';

export type PrivyExportHandoff = {
  status: 'open_browser';
  url: typeof PRIVY_HOME_URL;
};

/**
 * Where to send a Privy embedded wallet for export.
 *
 * `@privy-io/expo` 0.65.1 (and 0.78.2) has no browser export method. Privy only
 * runs that in the React web SDK, inside a secure browser. `recover()` restores
 * on-device entropy and does not show the key, so it is not used. This returns
 * Privy Home and nothing else — the sheet opens that URL and never reads a key.
 */
export function beginPrivyExport(): PrivyExportHandoff {
  return { status: 'open_browser', url: PRIVY_HOME_URL };
}

/** Accept only the bare Privy Home URL. Returns that constant, never the input. */
export function assertPrivyHomeUrl(url: string): typeof PRIVY_HOME_URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Privy export URL is not Privy Home');
  }
  const barePath = parsed.pathname === '/' || parsed.pathname === '';
  if (
    parsed.protocol !== 'https:'
    || parsed.hostname !== 'home.privy.io'
    || parsed.port !== ''
    || !barePath
    || parsed.search !== ''
    || parsed.hash !== ''
    || parsed.username !== ''
    || parsed.password !== ''
  ) {
    throw new Error('Privy export URL is not Privy Home');
  }
  return PRIVY_HOME_URL;
}

/**
 * What the system browser told us. `cancel` and `dismiss` mean the in-app
 * browser closed. `opened` means Android launched it and will not call back.
 * None of these say the key was copied. `locked` and anything else mean the
 * browser never became the user's next step.
 */
export function interpretPrivyExportSession(
  result: { type?: string } | null | undefined,
): 'handed_off' | 'failed' {
  if (result?.type === 'cancel' || result?.type === 'dismiss' || result?.type === 'opened') {
    return 'handed_off';
  }
  return 'failed';
}

function remember(state: ConnectFlowState, step: ConnectStep): ConnectFlowState {
  return { ...state, history: [...state.history, state.step], step };
}

export function reduceConnectFlow(state: ConnectFlowState, event: ConnectFlowEvent): ConnectFlowState {
  switch (event.type) {
    case 'open': {
      if (event.linked) {
        return {
          ...state,
          step: { kind: 'connected' },
          linked: event.linked,
          history: [],
          setupOutstanding: false,
          setupAttempts: 0,
          setupFailure: null,
          externalError: null,
        };
      }
      if (event.privyAuthenticated && (state.setupOutstanding || !event.hasEmbeddedWallet)) {
        return {
          ...state,
          step: { kind: 'fail_setup' },
          linked: null,
          history: [],
          setupOutstanding: true,
          externalError: null,
        };
      }
      return {
        ...state,
        step: { kind: 'choice' },
        linked: null,
        history: [],
        externalError: null,
      };
    }
    case 'back': {
      if (!canGoBack(state)) return state;
      const history = state.history.slice(0, -1);
      const step = state.history[state.history.length - 1];
      return { ...state, history, step, externalError: null };
    }
    case 'choose_create':
      if (state.step.kind !== 'choice') return state;
      return remember(state, { kind: 'create' });
    case 'choose_have':
      if (state.step.kind !== 'choice') return state;
      return remember(state, { kind: 'have' });
    case 'choose_email':
      if (state.step.kind !== 'create') return state;
      return remember(state, { kind: 'email' });
    case 'code_sent':
      if (state.step.kind !== 'email') return state;
      return remember(state, { kind: 'otp' });
    case 'otp_rejected':
      if (state.step.kind !== 'otp') return state;
      return state;
    case 'start_google':
      if (state.step.kind !== 'create') return state;
      return { ...state, step: { kind: 'signing_in' } };
    case 'login_cancelled':
      if (state.step.kind !== 'signing_in') return state;
      return { ...state, step: { kind: 'create' }, history: [{ kind: 'choice' }] };
    case 'login_failed':
      if (state.step.kind !== 'signing_in' && state.step.kind !== 'email' && state.step.kind !== 'otp') {
        return state;
      }
      return { ...state, step: { kind: 'fail_login' }, history: [] };
    case 'retry_login':
      if (state.step.kind !== 'fail_login') return state;
      return { ...state, step: { kind: 'create' }, history: [{ kind: 'choice' }] };
    case 'login_succeeded':
      if (state.step.kind !== 'otp' && state.step.kind !== 'signing_in') return state;
      return {
        ...state,
        step: { kind: 'creating' },
        history: [],
        setupOutstanding: true,
        setupAttempts: 0,
        setupFailure: null,
        linked: null,
        externalError: null,
      };
    case 'wallet_setup_failed':
      if (state.step.kind !== 'creating') return state;
      return {
        ...state,
        step: { kind: 'fail_setup' },
        history: [],
        setupAttempts: state.setupAttempts + 1,
        setupOutstanding: true,
        setupFailure: event.failure,
        linked: null,
      };
    case 'wallet_setup_succeeded':
      return {
        ...state,
        step: { kind: 'connected' },
        linked: event.linked,
        history: [],
        setupAttempts: 0,
        setupOutstanding: false,
        setupFailure: null,
        externalError: null,
      };
    case 'retry_wallet':
      if (state.step.kind !== 'fail_setup') return state;
      return { ...state, step: { kind: 'creating' } };
    case 'logout':
    case 'disconnected':
      return { ...INITIAL_CONNECT_FLOW };
    case 'choose_external':
      if (state.step.kind !== 'have') return state;
      return {
        ...state,
        step: { kind: 'connecting_external', wallet: event.wallet },
        externalWallet: event.wallet,
        externalError: null,
      };
    case 'external_cancelled':
      if (state.step.kind !== 'connecting_external') return state;
      return { ...state, step: { kind: 'have' }, externalError: null };
    case 'external_failed':
      if (state.step.kind !== 'connecting_external') return state;
      return { ...state, step: { kind: 'have' }, externalError: event.message };
    case 'open_export':
      if (state.step.kind !== 'connected' || state.linked !== 'privy') return state;
      return remember(state, { kind: 'export' });
    case 'export_not_now':
      if (state.step.kind !== 'export' || state.linked !== 'privy') return state;
      return { ...state, step: { kind: 'connected' }, history: [] };
    case 'export_continue':
      if (state.step.kind !== 'export' || state.linked !== 'privy') return state;
      return { ...state, step: { kind: 'export_opening' } };
    case 'export_handed_off':
      if (state.step.kind !== 'export_opening' || state.linked !== 'privy') return state;
      return { ...state, step: { kind: 'connected' }, history: [] };
    case 'export_failed':
      if (state.step.kind !== 'export_opening' || state.linked !== 'privy') return state;
      return { ...state, step: { kind: 'export_failed' } };
    case 'export_retry':
      if (state.step.kind !== 'export_failed' || state.linked !== 'privy') return state;
      return { ...state, step: { kind: 'export' }, history: [{ kind: 'connected' }] };
    case 'request_disconnect':
      if (state.step.kind !== 'connected' || !state.linked) return state;
      return { ...state, step: { kind: 'confirm_disconnect' }, history: [] };
    case 'cancel_disconnect':
      if (state.step.kind !== 'confirm_disconnect' || !state.linked) return state;
      return { ...state, step: { kind: 'connected' }, history: [] };
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}
