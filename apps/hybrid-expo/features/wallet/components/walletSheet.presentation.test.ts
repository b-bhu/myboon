import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Chain } from '@/features/chain/chain.contract';
import {
  continueAfterWalletRequirement,
  createWalletSheetRequest,
  deriveActiveWallets,
  deriveWalletSheetPresentation,
  deriveWalletTrigger,
  type WalletAccountSnapshot,
  type WalletSessionSnapshot,
} from './walletSheet.presentation';

const EXTERNAL_SOLANA: WalletAccountSnapshot = {
  chain: 'solana',
  address: '7iNJ7C1111111111111111111111111111111Vo9C',
  active: true,
  usable: true,
  source: 'external_wallet',
};

const PRIVY_SOLANA: WalletAccountSnapshot = {
  chain: 'solana',
  address: '9myboon111111111111111111111111111111Sol',
  active: true,
  usable: true,
  source: 'myboon_wallet',
};

const PRIVY_POLYGON: WalletAccountSnapshot = {
  chain: 'evm',
  address: '0xDd79000000000000000000000000000000001E40',
  active: true,
  usable: true,
  source: 'myboon_wallet',
};

function session(
  accounts: readonly WalletAccountSnapshot[] = [],
  overrides: Partial<WalletSessionSnapshot> = {},
): WalletSessionSnapshot {
  return {
    activationHydrated: true,
    privyAuthenticated: false,
    accounts,
    recoveryChains: [],
    ...overrides,
  };
}

function requirement(chain: Chain, applicationLabel = chain === 'evm' ? 'Polymarket' : 'Meteora') {
  return { kind: 'requirement' as const, chain, applicationLabel };
}

describe('global wallet trigger', () => {
  it('says Connect when no chain is active', () => {
    assert.deepEqual(deriveWalletTrigger(session()), {
      label: 'Connect',
      accessibilityLabel: 'Connect wallet',
      activeCount: 0,
    });
  });

  it('treats Polygon-only as a connected wallet session', () => {
    assert.deepEqual(deriveWalletTrigger(session([PRIVY_POLYGON])), {
      label: 'Wallets',
      accessibilityLabel: 'Manage wallets',
      activeCount: 1,
    });
  });

  it('does not flash a disconnected treatment during activation hydration', () => {
    assert.equal(
      deriveWalletTrigger(session([], { activationHydrated: false })).label,
      'Wallets',
    );
  });
});

describe('management mode', () => {
  it('uses Solana-primary onboarding when nothing is active', () => {
    const presentation = deriveWalletSheetPresentation({ kind: 'manage' }, session());
    assert.equal(presentation.kind, 'manage_empty');
    assert.equal(presentation.title, 'Connect your wallet');
    assert.deepEqual(presentation.options, ['email', 'google', 'external_wallet']);
    assert.deepEqual(presentation.wallets, []);
  });

  it('shows one Polygon row and no empty Solana state for Polygon-only', () => {
    const presentation = deriveWalletSheetPresentation(
      { kind: 'manage' },
      session([PRIVY_POLYGON], { privyAuthenticated: true }),
    );
    assert.equal(presentation.kind, 'manage_wallets');
    assert.deepEqual(presentation.wallets.map((wallet) => wallet.chain), ['evm']);
    assert.equal(presentation.wallets[0]?.sourceLabel, 'myboon wallet');
    assert.equal(presentation.wallets[0]?.usageLabel, 'Used by Polymarket');
  });

  it('shows both active chains, Solana first', () => {
    const presentation = deriveWalletSheetPresentation(
      { kind: 'manage' },
      session([PRIVY_POLYGON, EXTERNAL_SOLANA], { privyAuthenticated: true }),
    );
    assert.equal(presentation.title, 'Wallets');
    assert.deepEqual(presentation.wallets.map((wallet) => wallet.chain), ['solana', 'evm']);
    assert.equal(presentation.wallets[0]?.sourceLabel, 'External wallet');
  });

  it('renders one Solana row when external and embedded Solana coexist', () => {
    assert.deepEqual(
      deriveActiveWallets(session([EXTERNAL_SOLANA, PRIVY_SOLANA])).map((wallet) => [
        wallet.chain,
        wallet.source,
      ]),
      [['solana', 'external_wallet']],
    );
  });

  it('never renders a provisioned-but-dormant chain as active', () => {
    const dormantPolygon = { ...PRIVY_POLYGON, active: false };
    const presentation = deriveWalletSheetPresentation(
      { kind: 'manage' },
      session([EXTERNAL_SOLANA, dormantPolygon], { privyAuthenticated: true }),
    );
    assert.deepEqual(presentation.wallets.map((wallet) => wallet.chain), ['solana']);
  });

  it('offers explicit myboon activation instead of login to an authenticated user', () => {
    const presentation = deriveWalletSheetPresentation(
      { kind: 'manage' },
      session([], { privyAuthenticated: true }),
    );
    assert.equal(presentation.actionLabel, 'Use myboon wallet');
    assert.deepEqual(presentation.options, ['external_wallet']);
  });

  it('shows a neutral recovery state without claiming a recovery method', () => {
    const presentation = deriveWalletSheetPresentation(
      { kind: 'manage' },
      session([], { privyAuthenticated: true, recoveryChains: ['evm'] }),
    );
    assert.equal(presentation.kind, 'recovery');
    assert.equal(presentation.title, 'Wallet unavailable on this device');
    assert.doesNotMatch(presentation.body, /icloud|google drive|passcode|recovery key/i);
  });

  it('uses the same neutral recovery state for an unavailable Solana wallet', () => {
    const presentation = deriveWalletSheetPresentation(
      requirement('solana'),
      session([], { privyAuthenticated: true, recoveryChains: ['solana'] }),
    );
    assert.equal(presentation.kind, 'recovery');
    assert.equal(presentation.title, 'Wallet unavailable on this device');
    assert.doesNotMatch(presentation.body, /icloud|google drive|passcode|recovery key/i);
  });
});

describe('application requirement mode', () => {
  it('keeps email and Google available for Polygon when only Solana is active', () => {
    const presentation = deriveWalletSheetPresentation(
      requirement('evm'),
      session([EXTERNAL_SOLANA]),
    );
    assert.equal(presentation.kind, 'requirement_options');
    assert.equal(presentation.title, 'Connect Polygon wallet');
    assert.deepEqual(presentation.options, ['email', 'google']);
    assert.equal(
      presentation.reassurance,
      'Your Solana wallet stays connected and unchanged.',
    );
    assert.deepEqual(presentation.wallets, []);
  });

  it('offers Enable Polygon wallet without another login when Privy is authenticated', () => {
    const presentation = deriveWalletSheetPresentation(
      requirement('evm'),
      session([EXTERNAL_SOLANA], { privyAuthenticated: true }),
    );
    assert.equal(presentation.kind, 'requirement_enable');
    assert.equal(presentation.actionLabel, 'Enable Polygon wallet');
    assert.deepEqual(presentation.options, []);
  });

  it('offers Solana choices only for a Solana requirement', () => {
    const presentation = deriveWalletSheetPresentation(
      requirement('solana', 'Phoenix'),
      session([PRIVY_POLYGON]),
    );
    assert.equal(presentation.contextRail, 'PHOENIX · SOLANA');
    assert.deepEqual(presentation.options, ['email', 'google', 'external_wallet']);
    assert.equal(presentation.wallets.length, 0);
  });

  it('marks a requested active chain satisfied and never renders the other chain as a row', () => {
    for (const chain of ['solana', 'evm'] as const) {
      const presentation = deriveWalletSheetPresentation(
        requirement(chain),
        session([EXTERNAL_SOLANA, PRIVY_POLYGON], { privyAuthenticated: true }),
      );
      assert.equal(presentation.kind, 'requirement_satisfied');
      assert.deepEqual(presentation.wallets.map((wallet) => wallet.chain), [chain]);
    }
  });
});

describe('external Solana → Polymarket regression', () => {
  it('cancel leaves Solana untouched; satisfying Polygon resumes Polymarket exactly once', async () => {
    const accounts = [EXTERNAL_SOLANA];
    const opened = deriveWalletSheetPresentation(requirement('evm'), session(accounts));
    assert.equal(opened.kind, 'requirement_options');
    assert.deepEqual(opened.options, ['email', 'google']);

    let enableCalls = 0;
    const cancelled = createWalletSheetRequest();
    const cancelledContinuation = continueAfterWalletRequirement(
      cancelled.promise,
      () => { enableCalls += 1; },
    );
    cancelled.cancel();
    assert.equal(await cancelledContinuation, 'cancelled');
    assert.equal(enableCalls, 0, 'Polymarket must not resume after cancellation');
    assert.deepEqual(accounts, [EXTERNAL_SOLANA], 'cancellation must not mutate Solana');

    const satisfied = createWalletSheetRequest();
    const satisfiedContinuation = continueAfterWalletRequirement(
      satisfied.promise,
      () => { enableCalls += 1; },
    );
    const bothChains = [...accounts, PRIVY_POLYGON];
    const ready = deriveWalletSheetPresentation(
      requirement('evm'),
      session(bothChains, { privyAuthenticated: true }),
    );
    assert.equal(ready.kind, 'requirement_satisfied');
    assert.equal(bothChains[0], EXTERNAL_SOLANA, 'Polygon activation must not replace Solana');
    satisfied.satisfy();
    assert.equal(await satisfiedContinuation, 'satisfied');
    assert.equal(enableCalls, 1, 'Polymarket resumes once after a usable Polygon wallet');
  });

  it('technical failure rejects instead of looking like cancellation', async () => {
    const request = createWalletSheetRequest();
    request.fail(new Error('provisioning failed'));
    await assert.rejects(request.promise, /provisioning failed/);
  });
});
