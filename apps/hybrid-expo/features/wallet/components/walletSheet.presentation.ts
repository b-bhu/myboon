import type { Chain } from '@/features/chain/chain.contract';
import {
  availableOptions,
  type ConnectOption,
} from '@/features/wallet/components/connect.options';

export type WalletSheetIntent =
  | { kind: 'manage' }
  | {
      kind: 'requirement';
      chain: Chain;
      applicationLabel: string;
    };

export type WalletSheetOutcome = 'satisfied' | 'cancelled';

export type WalletAccountSource = 'external_wallet' | 'myboon_wallet';

export interface WalletAccountSnapshot {
  chain: Chain;
  address: string | null;
  active: boolean;
  usable: boolean;
  source: WalletAccountSource;
}

export interface WalletSessionSnapshot {
  activationHydrated: boolean;
  privyAuthenticated: boolean;
  accounts: readonly WalletAccountSnapshot[];
  /** Recorded wallets that exist but cannot sign on this device. */
  recoveryChains?: readonly Chain[];
}

export interface WalletRowPresentation {
  chain: Chain;
  chainLabel: 'Solana' | 'Polygon';
  address: string;
  source: WalletAccountSource;
  sourceLabel: 'External wallet' | 'myboon wallet';
  usageLabel: 'Used by Polymarket' | null;
}

export type WalletSheetPresentationKind =
  | 'preparing'
  | 'manage_empty'
  | 'manage_wallets'
  | 'requirement_options'
  | 'requirement_enable'
  | 'requirement_satisfied'
  | 'recovery';

export interface WalletSheetPresentation {
  kind: WalletSheetPresentationKind;
  contextRail: string;
  title: string;
  body: string;
  reassurance: string | null;
  actionLabel: string | null;
  options: readonly ConnectOption[];
  wallets: readonly WalletRowPresentation[];
  recoveryChains: readonly Chain[];
  activeCount: number;
}

const CHAIN_LABEL: Record<Chain, 'Solana' | 'Polygon'> = {
  solana: 'Solana',
  evm: 'Polygon',
};

const CHAIN_RAIL_LABEL: Record<Chain, string> = {
  solana: 'SOLANA',
  evm: 'POLYGON',
};

function toWalletRow(account: WalletAccountSnapshot): WalletRowPresentation | null {
  if (!account.active || !account.usable || !account.address) return null;
  return {
    chain: account.chain,
    chainLabel: CHAIN_LABEL[account.chain],
    address: account.address,
    source: account.source,
    sourceLabel: account.source === 'external_wallet' ? 'External wallet' : 'myboon wallet',
    usageLabel: account.chain === 'evm' ? 'Used by Polymarket' : null,
  };
}

/** One active row per chain, ordered Solana first. */
export function deriveActiveWallets(
  session: WalletSessionSnapshot,
): readonly WalletRowPresentation[] {
  const byChain = new Map<Chain, WalletRowPresentation>();
  for (const account of session.accounts) {
    const row = toWalletRow(account);
    if (row && !byChain.has(row.chain)) byChain.set(row.chain, row);
  }
  return (['solana', 'evm'] as const).flatMap((chain) => {
    const row = byChain.get(chain);
    return row ? [row] : [];
  });
}

export function isRequirementSatisfied(
  session: WalletSessionSnapshot,
  chain: Chain,
): boolean {
  if (!session.activationHydrated) return false;
  return deriveActiveWallets(session).some((wallet) => wallet.chain === chain);
}

export function deriveWalletTrigger(session: WalletSessionSnapshot): {
  label: 'Connect' | 'Wallets';
  accessibilityLabel: 'Connect wallet' | 'Manage wallets';
  activeCount: number;
} {
  const activeCount = deriveActiveWallets(session).length;
  // During persisted activation hydration, prefer the neutral manager treatment
  // over briefly telling a returning EVM-only user that they are disconnected.
  if (!session.activationHydrated || activeCount > 0) {
    return { label: 'Wallets', accessibilityLabel: 'Manage wallets', activeCount };
  }
  return { label: 'Connect', accessibilityLabel: 'Connect wallet', activeCount: 0 };
}

export function deriveWalletSheetPresentation(
  intent: WalletSheetIntent,
  session: WalletSessionSnapshot,
): WalletSheetPresentation {
  const activeWallets = deriveActiveWallets(session);
  const recoveryChains = session.recoveryChains ?? [];

  if (!session.activationHydrated) {
    return {
      kind: 'preparing',
      contextRail: intent.kind === 'manage'
        ? 'WALLETS'
        : `${intent.applicationLabel.toUpperCase()} · ${CHAIN_RAIL_LABEL[intent.chain]}`,
      title: 'Checking wallets…',
      body: 'Restoring the wallets active in this session.',
      reassurance: null,
      actionLabel: null,
      options: [],
      wallets: [],
      recoveryChains,
      activeCount: 0,
    };
  }

  if (intent.kind === 'manage') {
    if (activeWallets.length > 0) {
      return {
        kind: 'manage_wallets',
        contextRail: 'WALLETS',
        title: 'Wallets',
        body: 'Manage the accounts myboon uses.',
        reassurance: null,
        actionLabel: null,
        options: [],
        wallets: activeWallets,
        recoveryChains,
        activeCount: activeWallets.length,
      };
    }

    if (recoveryChains.length > 0) {
      return {
        kind: 'recovery',
        contextRail: 'WALLETS',
        title: 'Wallet unavailable on this device',
        body: 'A recorded wallet cannot sign on this device. Contact myboon support before creating another wallet.',
        reassurance: null,
        actionLabel: 'Open myboon support',
        options: [],
        wallets: [],
        recoveryChains,
        activeCount: 0,
      };
    }

    return {
      kind: 'manage_empty',
      contextRail: 'WALLETS',
      title: 'Connect your wallet',
      body: session.privyAuthenticated
        ? 'Use your myboon wallet for Solana, or connect an external Solana wallet.'
        : 'Start with a myboon wallet or connect a Solana wallet you use.',
      reassurance: null,
      actionLabel: session.privyAuthenticated ? 'Use myboon wallet' : null,
      options: session.privyAuthenticated
        ? availableOptions('solana').filter((option) => option === 'external_wallet')
        : availableOptions('solana'),
      wallets: [],
      recoveryChains: [],
      activeCount: 0,
    };
  }

  const requestedWallet = activeWallets.find((wallet) => wallet.chain === intent.chain);
  const otherWallet = activeWallets.find((wallet) => wallet.chain !== intent.chain);
  const contextRail = `${intent.applicationLabel.toUpperCase()} · ${CHAIN_RAIL_LABEL[intent.chain]}`;
  const reassurance = otherWallet
    ? `Your ${otherWallet.chainLabel} wallet stays connected and unchanged.`
    : null;

  if (recoveryChains.includes(intent.chain)) {
    return {
      kind: 'recovery',
      contextRail,
      title: 'Wallet unavailable on this device',
      body: `Your recorded ${CHAIN_LABEL[intent.chain]} wallet cannot sign on this device. Contact myboon support before creating another wallet.`,
      reassurance,
      actionLabel: 'Open myboon support',
      options: [],
      wallets: [],
      recoveryChains,
      activeCount: activeWallets.length,
    };
  }

  if (requestedWallet) {
    return {
      kind: 'requirement_satisfied',
      contextRail,
      title: `${requestedWallet.chainLabel} wallet ready`,
      body: `${intent.applicationLabel} can now use this wallet.`,
      reassurance,
      actionLabel: null,
      options: [],
      // Requirement mode names only the requested chain. Other chains remain
      // active session state, but never appear as unrelated cards or actions.
      wallets: [requestedWallet],
      recoveryChains: [],
      activeCount: activeWallets.length,
    };
  }

  if (session.privyAuthenticated) {
    return {
      kind: 'requirement_enable',
      contextRail,
      title: intent.chain === 'evm'
        ? 'Enable your Polygon wallet'
        : 'Use your myboon Solana wallet',
      body: intent.chain === 'evm'
        ? 'You’re already signed in to myboon. No new login is needed.'
        : `Use your myboon wallet for ${intent.applicationLabel}.`,
      reassurance,
      actionLabel: intent.chain === 'evm' ? 'Enable Polygon wallet' : 'Use myboon wallet',
      options: intent.chain === 'solana'
        ? availableOptions('solana').filter((option) => option === 'external_wallet')
        : [],
      wallets: [],
      recoveryChains: [],
      activeCount: activeWallets.length,
    };
  }

  return {
    kind: 'requirement_options',
    contextRail,
    title: `Connect ${CHAIN_LABEL[intent.chain]} wallet`,
    body: intent.chain === 'evm'
      ? `${intent.applicationLabel} uses a Polygon wallet for orders, deposits and payouts.`
      : `Choose the wallet you’ll use for ${intent.applicationLabel}.`,
    reassurance,
    actionLabel: null,
    options: availableOptions(intent.chain),
    wallets: [],
    recoveryChains: [],
    activeCount: activeWallets.length,
  };
}

export interface WalletSheetRequest {
  promise: Promise<WalletSheetOutcome>;
  satisfy: () => void;
  cancel: () => void;
  fail: (error: Error) => void;
  isSettled: () => boolean;
}

/** A one-shot request used by the provider without coupling tests to React. */
export function createWalletSheetRequest(): WalletSheetRequest {
  let settled = false;
  let resolveRequest!: (outcome: WalletSheetOutcome) => void;
  let rejectRequest!: (error: Error) => void;
  const promise = new Promise<WalletSheetOutcome>((resolve, reject) => {
    resolveRequest = resolve;
    rejectRequest = reject;
  });

  const finish = (callback: () => void) => {
    if (settled) return;
    settled = true;
    callback();
  };

  return {
    promise,
    satisfy: () => finish(() => resolveRequest('satisfied')),
    cancel: () => finish(() => resolveRequest('cancelled')),
    fail: (error) => finish(() => rejectRequest(error)),
    isSettled: () => settled,
  };
}

/** Run application setup only after the requested chain is genuinely usable. */
export async function continueAfterWalletRequirement(
  request: Promise<WalletSheetOutcome>,
  onSatisfied: () => void | Promise<void>,
): Promise<WalletSheetOutcome> {
  const outcome = await request;
  if (outcome === 'satisfied') await onSatisfied();
  return outcome;
}
