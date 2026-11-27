import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearMwaAccount,
  getMwaAccountCleared,
  pickWalletSession,
  readMwaAddress,
  resetMwaSessionForTests,
  restoreMwaAccount,
  subscribeMwaAccountCleared,
  type WalletSessionInput,
} from '../../hooks/walletSession';

const EXTERNAL = 'MwaShared11111111111111111111111111111111111';
const EMAIL = 'PrivyEmail111111111111111111111111111111111111';

function sessionInput(overrides: Partial<WalletSessionInput> = {}): WalletSessionInput {
  return {
    mwaAccountCleared: false,
    mwaAddress: EXTERNAL,
    privyIsPrivyUser: false,
    privyIsPreparing: false,
    privyConnected: false,
    privyAddress: null,
    ...overrides,
  };
}

test('external connect selects the external wallet while the session is live', () => {
  resetMwaSessionForTests();
  assert.equal(getMwaAccountCleared(), false);

  // No Privy user in the picture: the external wallet wins.
  assert.deepEqual(pickWalletSession(sessionInput()), { source: 'mwa', address: EXTERNAL });

  // Privy signed in underneath: the deliberately connected external wallet
  // still wins once Privy has settled.
  assert.deepEqual(
    pickWalletSession(sessionInput({
      privyIsPrivyUser: true,
      privyConnected: true,
      privyAddress: EMAIL,
    })),
    { source: 'mwa', address: EXTERNAL },
  );
});

test('a shared disconnect reaches every consumer and drops the external wallet', () => {
  resetMwaSessionForTests();

  // Two useWallet() consumers subscribed on two screens.
  const consumers = ['sheet', 'home'].map(() => {
    const counter = { seen: 0 };
    const unsubscribe = subscribeMwaAccountCleared(() => {
      counter.seen += 1;
    });
    return { counter, unsubscribe };
  });

  clearMwaAccount();

  // One clear, heard by both — the disconnect is no longer per-screen state.
  assert.equal(consumers[0].counter.seen, 1);
  assert.equal(consumers[1].counter.seen, 1);
  assert.equal(getMwaAccountCleared(), true);
  for (const consumer of consumers) consumer.unsubscribe();
});

test('after the shared disconnect an email login selects the email wallet, not the stale external account', () => {
  resetMwaSessionForTests();
  clearMwaAccount();

  // Control for the regression this fixes: without the shared clear, a Privy
  // session that settled after the disconnect would still prefer the stale
  // external account (`preferMwa`) — the crash path Home used to show.
  assert.deepEqual(
    pickWalletSession(sessionInput({ privyIsPrivyUser: true, privyConnected: true, privyAddress: EMAIL })),
    { source: 'mwa', address: EXTERNAL },
  );

  // With the shared clear: same inputs, but the email/Privy wallet is selected
  // even though the adapter cache still reports the external account.
  assert.deepEqual(
    pickWalletSession(sessionInput({
      mwaAccountCleared: true,
      privyIsPrivyUser: true,
      privyConnected: true,
      privyAddress: EMAIL,
    })),
    { source: 'privy', address: EMAIL },
  );
});

test('before Privy settles, the hydration window still reports a disconnected Privy session', () => {
  resetMwaSessionForTests();

  // isPreparing means no wallet yet: connected/address are false/null with it.
  assert.deepEqual(
    pickWalletSession(sessionInput({ privyIsPrivyUser: true, privyIsPreparing: true })),
    { source: 'privy', address: null },
  );

  // The shared disconnect during the hydration window changes nothing: no
  // cached external account leaks while Privy is still preparing.
  assert.deepEqual(
    pickWalletSession(sessionInput({ privyIsPrivyUser: true, privyIsPreparing: true, mwaAccountCleared: true })),
    { source: 'privy', address: null },
  );
});

test('reconnecting the external wallet re-arms external selection', () => {
  resetMwaSessionForTests();
  clearMwaAccount();
  assert.equal(getMwaAccountCleared(), true);

  restoreMwaAccount();

  assert.equal(getMwaAccountCleared(), false);
  assert.deepEqual(pickWalletSession(sessionInput()), { source: 'mwa', address: EXTERNAL });
});

test('a non-string adapter address without a safe toBase58 is no external address and does not throw', () => {
  assert.equal(readMwaAddress(null), null);
  assert.equal(readMwaAddress(undefined), null);
  assert.equal(readMwaAddress({}), null);
  assert.equal(readMwaAddress({ address: null }), null);
  assert.equal(readMwaAddress({ address: 4242 }), null);
  assert.equal(readMwaAddress({ address: { } }), null);
  assert.equal(readMwaAddress({ address: { toBase58: 7 } }), null);
  assert.equal(readMwaAddress({ address: { toBase58: () => { throw new Error('boom'); } } }), null);
  assert.equal(readMwaAddress({ address: { toBase58: () => 42 } }), null);

  // Strings and a working toBase58 still resolve; an empty string is none.
  assert.equal(readMwaAddress({ address: EXTERNAL }), EXTERNAL);
  assert.equal(readMwaAddress({ address: { toBase58: () => EMAIL } }), EMAIL);
  assert.equal(readMwaAddress({ address: '' }), null);
});
