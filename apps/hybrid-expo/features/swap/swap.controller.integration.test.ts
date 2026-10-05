import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import {
  createControllerFixture,
  deferred,
  fixtureSol,
  fixtureUsdc,
} from './swap.controller.fixture';
import type { SwapOrderResponse } from './swap.types';

test('inline and routed modes start empty; quote resolves without preparing/signing/submitting', async (t) => {
  for (const mode of ['swap', 'buy', 'sell'] as const) {
    const h = await createControllerFixture({
      mode,
      requestedMint: mode === 'swap' ? undefined : fixtureUsdc,
    });
    t.after(() => h.dispose());
    assert.equal(h.current.amount, '');
    assert.equal(h.current.reviewOrder, null);
    if (mode === 'buy') assert.equal(h.current.outputToken.address, fixtureUsdc);
    if (mode === 'sell') assert.equal(h.current.inputToken.address, fixtureUsdc);
    await h.run((c) => c.setManualAmount('1'));
    await h.settle(470);
    assert.equal(h.current.quote?.kind, 'quote');
    assert.equal(h.current.phase, 'compose');
    assert.equal(h.fixture.calls.orders.length, 0);
    assert.equal(h.fixture.calls.sign, 0);
    assert.equal(h.fixture.calls.execute, 0);
  }
});

test('explicit review validates/simulates, approval executes once, and confirmed refreshes', async (t) => {
  const h = await createControllerFixture();
  t.after(() => h.dispose());
  await h.run((c) => c.setManualAmount('1'));
  await h.run((c) => c.prepareReview());
  assert.equal(h.current.phase, 'reviewing');
  assert.equal(h.fixture.calls.validate, 1);
  assert.equal(h.fixture.calls.simulate, 1);
  assert.equal(h.fixture.calls.sign, 0);
  await h.run(async (c) => {
    await Promise.all([c.confirmTrade(), c.confirmTrade()]);
  });
  assert.equal(h.current.phase, 'confirmed');
  assert.equal(h.fixture.calls.sign, 1);
  assert.equal(h.fixture.calls.execute, 1);
  assert.equal(h.fixture.calls.refresh, 1);
  assert.deepEqual(await h.fixture.store.list(h.fixture.wallet.address!), []);
});

test('same-tick review blocks reverse/input and leaving Wallet discards a late preparation', async (t) => {
  const h = await createControllerFixture();
  t.after(() => h.dispose());
  const balance = deferred<Record<string, string>>();
  await h.run((c) => c.setManualAmount('1'));
  h.fixture.balanceRequest = () => balance.promise;
  let preparation!: Promise<void>;
  await h.run((c) => {
    preparation = c.prepareReview();
    c.reversePair();
    c.setManualAmount('2');
  });
  assert.equal(h.current.inputToken.address, fixtureSol);
  assert.equal(h.current.amount, '1');
  await h.update({ active: false });
  balance.resolve(h.fixture.balances);
  await h.run(async () => {
    await preparation;
  });
  assert.equal(h.current.reviewOrder, null);
  assert.equal(h.fixture.calls.orders.length, 0);
  await h.update({ active: true });
  assert.equal(h.current.amount, '1');
  assert.equal(h.current.reviewOrder, null);
  assert.equal(h.current.phase, 'compose');
  await h.run((c) => c.setManualAmount('2'));
  assert.equal(h.current.amount, '2');
});

test('a stale quote cannot overwrite a newer input, including clearing invalid input', async (t) => {
  const h = await createControllerFixture();
  t.after(() => h.dispose());
  const old = deferred<SwapOrderResponse>();
  h.fixture.quoteRequest = async (request) =>
    request.amountAtomic === '1000000000' ? old.promise : h.baseOrder(request);
  await h.run((c) => c.setManualAmount('1'));
  await h.settle(470);
  await h.run((c) => c.setManualAmount('2'));
  await h.settle(470);
  assert.equal(h.current.quote?.inAmountAtomic, '2000000000');
  await h.run((c) => c.setManualAmount(''));
  old.resolve(
    h.baseOrder({ inputMint: fixtureSol, outputMint: fixtureUsdc, amountAtomic: '1000000000' }),
  );
  await h.settle();
  assert.equal(h.current.quote, null);
  assert.equal(h.current.reviewOrder, null);
});

test('elevated slippage and acknowledgements reset across sessions without restoring a prepared order', async (t) => {
  const h = await createControllerFixture();
  t.after(() => h.dispose());
  await h.run((c) => c.setManualAmount('1'));
  await h.run((c) => c.setSlippageMode('custom'));
  await h.run((c) => c.setCustomSlippage('20'));
  await h.run((c) => c.prepareReview());
  assert.equal(h.fixture.calls.orders.length, 0);
  assert.match(h.current.failure ?? '', /CONFIRM/);
  await h.run((c) => c.setExtremeConfirmation('CONFIRM'));
  await h.run((c) => c.prepareReview());
  assert.equal(h.current.reviewOrder?.slippageBps, 2000);
  await h.update({ active: false });
  await h.update({ active: true });
  assert.equal(h.current.slippageMode, 'auto');
  assert.equal(h.current.extremeConfirmation, '');
  assert.equal(h.current.simulationWarningAccepted, false);
  assert.equal(h.current.reviewOrder, null);
  assert.equal(h.current.amount, '1');
});

test('invalidation makes an old confirmation callback unable to sign', async (t) => {
  const h = await createControllerFixture();
  t.after(() => h.dispose());
  await h.run((c) => c.setManualAmount('1'));
  await h.run((c) => c.prepareReview());
  const oldConfirm = h.current.confirmTrade;
  await h.run((c) => c.setManualAmount('2'));
  await h.run(() => oldConfirm());
  assert.equal(h.fixture.calls.sign, 0);
  assert.equal(h.fixture.calls.execute, 0);
  assert.equal(h.current.reviewOrder, null);
});

test('balance failure and fee reserve block review; retry keeps safe input', async (t) => {
  const h = await createControllerFixture();
  t.after(() => h.dispose());
  await h.run((c) => c.setManualAmount('2.996'));
  await h.run((c) => c.prepareReview());
  assert.match(h.current.failure ?? '', /0.005 SOL/);
  assert.equal(h.fixture.calls.orders.length, 0);
  h.fixture.balanceError = new Error('Fixture balance unavailable');
  await h.run((c) => c.retry());
  await h.run((c) => c.setManualAmount('1'));
  await h.run((c) => c.prepareReview());
  assert.equal(h.current.balancesResolved, false);
  assert.match(h.current.balancesError ?? '', /unavailable/);
  h.fixture.balanceError = null;
  await h.run((c) => c.retryBalances());
  assert.equal(h.current.amount, '1');
  assert.equal(h.current.balancesResolved, true);
});

test('simulation refusal blocks signing; unavailable simulation requires acknowledgement', async (t) => {
  const h = await createControllerFixture();
  t.after(() => h.dispose());
  await h.run((c) => c.setManualAmount('1'));
  h.fixture.simulationError = new Error('Fixture minimum received violation');
  await h.run((c) => c.prepareReview());
  assert.equal(h.current.reviewOrder, null);
  assert.equal(h.current.phase, 'failed');
  assert.equal(h.fixture.calls.sign, 0);
  h.fixture.simulationError = null;
  h.fixture.simulationWarning = 'Fixture simulation unavailable';
  await h.run((c) => c.retry());
  await h.run((c) => c.prepareReview());
  assert.equal(h.current.phase, 'reviewing');
  await h.run((c) => c.confirmTrade());
  assert.equal(h.fixture.calls.sign, 0);
  await h.run((c) => c.setSimulationWarningAccepted(true));
  await h.run((c) => c.confirmTrade());
  assert.equal(h.fixture.calls.sign, 1);
});

test('wallet rejection and definite execution failure never report confirmed', async (t) => {
  const h = await createControllerFixture();
  t.after(() => h.dispose());
  await h.run((c) => c.setManualAmount('1'));
  await h.run((c) => c.prepareReview());
  h.fixture.signError = new Error('User rejected');
  await h.run((c) => c.confirmTrade());
  assert.equal(h.current.phase, 'failed');
  assert.equal(h.fixture.calls.execute, 0);
  h.fixture.signError = null;
  h.fixture.executionOutcome = 'failed';
  await h.run((c) => c.retry());
  await h.run((c) => c.prepareReview());
  await h.run((c) => c.confirmTrade());
  assert.equal(h.current.phase, 'failed');
  assert.equal(h.fixture.calls.execute, 1);
});

test('unknown execution persists reviewed parameters across navigation and reconciles on resume', async (t) => {
  const h = await createControllerFixture();
  t.after(() => h.dispose());
  h.fixture.executionOutcome = 'unknown';
  h.fixture.statusError = new Error('Fixture RPC offline');
  await h.run((c) => c.setManualAmount('1'));
  await h.run((c) => c.prepareReview());
  await h.run((c) => c.confirmTrade());
  assert.equal(h.current.phase, 'unknown');
  const before = await h.fixture.store.list(h.fixture.wallet.address!);
  assert.equal(before.length, 1);
  await h.update({ active: false });
  await h.update({ active: true });
  await h.run((c) => {
    c.retry();
    c.reversePair();
    c.setManualAmount('2');
  });
  assert.equal(h.fixture.calls.execute, 1);
  assert.equal(h.current.amount, '1');
  assert.deepEqual(await h.fixture.store.list(h.fixture.wallet.address!), before);
  h.fixture.statusError = null;
  h.fixture.signatureStatus = { err: null, confirmationStatus: 'confirmed' };
  await h.resume();
  await h.settle();
  assert.equal(h.current.phase, 'confirmed');
  assert.equal(h.fixture.calls.execute, 1);
  assert.equal((await h.fixture.store.list(h.fixture.wallet.address!)).length, 0);
});

test('guest entry offers Solana connection; locked routed sides cannot open pickers', async (t) => {
  const guest = await createControllerFixture({ active: false });
  t.after(() => guest.dispose());
  guest.fixture.wallet = {
    ...guest.fixture.wallet,
    connected: false,
    address: null,
    sessionKey: 'disconnected',
  } as typeof guest.fixture.wallet;
  await guest.update({ active: true });
  await guest.run((c) => c.prepareReview());
  assert.equal(guest.fixture.calls.connect, 1);
  assert.equal(Object.keys(guest.current.balances).length, 0);
  assert.equal(guest.fixture.calls.sign, 0);
  for (const mode of ['buy', 'sell'] as const) {
    const h = await createControllerFixture({ mode, requestedMint: fixtureUsdc });
    t.after(() => h.dispose());
    await h.run((c) => c.openPicker(mode === 'buy' ? 'output' : 'input'));
    assert.equal(h.current.phase, 'compose');
  }
});

test('blocked mutations during preparation leave the in-flight review intact', async (t) => {
  const h = await createControllerFixture();
  t.after(() => h.dispose());
  await h.run((c) => c.setManualAmount('1'));
  await h.run(async (c) => {
    const preparation = c.prepareReview();
    c.reversePair();
    c.setManualAmount('2');
    c.openPicker('output');
    c.setSlippageMode('custom');
    await preparation;
  });
  assert.equal(h.current.amount, '1');
  assert.equal(h.current.slippageMode, 'auto');
  assert.equal(h.current.reviewOrder?.inAmountAtomic, '1000000000');
  assert.equal(h.current.phase, 'reviewing');
});

test('same-tick confirmation blocks changes to reviewed composition', async (t) => {
  const h = await createControllerFixture();
  t.after(() => h.dispose());
  await h.run((c) => c.setManualAmount('1'));
  await h.run((c) => c.prepareReview());
  await h.run(async (c) => {
    const confirming = c.confirmTrade();
    c.reversePair();
    c.setManualAmount('2');
    c.setSlippageMode('custom');
    await confirming;
  });
  assert.equal(h.current.inputToken.address, fixtureSol);
  assert.equal(h.current.amount, '1');
  assert.equal(h.current.slippageMode, 'auto');
  assert.equal(h.fixture.calls.execute, 1);
  assert.equal(h.current.phase, 'confirmed');
});

test('wallet change discards old balances, prepared review and old signing callback', async (t) => {
  const h = await createControllerFixture();
  t.after(() => h.dispose());
  await h.run((c) => c.setManualAmount('1'));
  await h.run((c) => c.prepareReview());
  const oldConfirm = h.current.confirmTrade;
  const address = Keypair.generate().publicKey.toBase58();
  h.fixture.wallet = {
    ...h.fixture.wallet,
    address,
    sessionKey: `privy:${address}`,
    source: 'privy',
  } as typeof h.fixture.wallet;
  await h.update();
  await h.run(() => oldConfirm());
  assert.equal(h.current.reviewOrder, null);
  assert.equal(h.fixture.calls.sign, 0);
  assert.equal(h.fixture.calls.execute, 0);
});

test('previous wallet balance response cannot replace current wallet balances', async (t) => {
  const h = await createControllerFixture({ active: false });
  t.after(() => h.dispose());
  const old = deferred<Record<string, string>>();
  h.fixture.balanceRequest = () => old.promise;
  await h.update({ active: true });
  h.fixture.balanceRequest = null;
  h.fixture.balances = { [fixtureSol]: '5000000000' };
  const address = Keypair.generate().publicKey.toBase58();
  h.fixture.wallet = {
    ...h.fixture.wallet,
    address,
    sessionKey: `mwa:${address}`,
  } as typeof h.fixture.wallet;
  await h.update();
  old.resolve({ [fixtureSol]: '9999999999' });
  await h.settle();
  assert.equal(h.current.inputBalanceAtomic, '5000000000');
});

test('pending startup blocks fresh preparation, expiry reconciliation releases the gate', async (t) => {
  const h = await createControllerFixture({ active: false });
  t.after(() => h.dispose());
  await h.fixture.store.save({
    version: 1,
    requestId: 'previous',
    walletAddress: h.fixture.wallet.address!,
    inputMint: fixtureSol,
    outputMint: fixtureUsdc,
    inAmountAtomic: '1000000000',
    minimumOutAmountAtomic: '149250000',
    signature: null,
    lastValidBlockHeight: '150',
    outcome: 'unknown',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  await h.update({ active: true });
  assert.equal(h.current.phase, 'unknown');
  await h.run((c) => c.prepareReview());
  assert.equal(h.fixture.calls.orders.length, 0);
  h.fixture.blockHeight = 151;
  await h.resume();
  await h.settle();
  assert.equal(h.current.phase, 'compose');
  assert.equal(h.current.pendingReady, true);
  assert.equal((await h.fixture.store.list(h.fixture.wallet.address!)).length, 0);
});

test('quote expiry becomes an explicit stale state without authorizing signing', async (t) => {
  const h = await createControllerFixture();
  t.after(() => h.dispose());
  h.fixture.quoteRequest = async (request) => ({
    ...h.baseOrder(request),
    expiresAt: new Date(Date.now() + 20).toISOString(),
  });
  await h.run((c) => c.setManualAmount('1'));
  await h.settle(470);
  await h.settle(40);
  assert.equal(h.current.quote, null);
  assert.match(h.current.quoteError ?? '', /expir/i);
  assert.equal(h.fixture.calls.orders.length, 0);
  assert.equal(h.fixture.calls.sign, 0);
});

test('picker search ignores late responses; same-mint selection reverses identity and clears amount', async (t) => {
  const h = await createControllerFixture();
  t.after(() => h.dispose());
  const old = deferred<typeof h.fixture.tokens>();
  h.fixture.searchRequest = async (query) =>
    query === '' ? old.promise : h.fixture.tokens.filter((token) => token.symbol === 'USDC');
  await h.run((c) => c.setManualAmount('1'));
  await h.run((c) => c.openPicker('input'));
  await h.settle(340);
  await h.run((c) => c.setTokenQuery('USDC'));
  await h.settle(340);
  assert.equal(h.current.tokenResults.length, 1);
  old.resolve(h.fixture.tokens);
  await h.settle();
  assert.equal(h.current.tokenResults.length, 1);
  await h.run((c) => c.selectToken(h.fixture.tokens[1]));
  assert.equal(h.current.inputToken.address, fixtureUsdc);
  assert.equal(h.current.outputToken.address, fixtureSol);
  assert.equal(h.current.amount, '');
  assert.equal(h.current.quote, null);
});

test('strict effect remount keeps balance and quote requests functional', async (t) => {
  const h = await createControllerFixture({}, true);
  t.after(() => h.dispose());
  assert.equal(h.current.balancesResolved, true);
  await h.run((c) => c.setManualAmount('1'));
  await h.settle(470);
  assert.equal(h.current.quote?.kind, 'quote');
});

test('previous wallet balance rejection cannot clear current resolved balances', async (t) => {
  const h = await createControllerFixture({ active: false });
  t.after(() => h.dispose());
  const old = deferred<Record<string, string>>();
  h.fixture.balanceRequest = () => old.promise;
  await h.update({ active: true });
  h.fixture.balanceRequest = null;
  h.fixture.balances = { [fixtureSol]: '5000000000' };
  const address = Keypair.generate().publicKey.toBase58();
  h.fixture.wallet = {
    ...h.fixture.wallet,
    address,
    sessionKey: `mwa:${address}`,
  } as typeof h.fixture.wallet;
  await h.update();
  old.reject(new Error('Previous wallet balance failed'));
  await h.settle();
  assert.equal(h.current.balancesResolved, true);
  assert.equal(h.current.balancesError, null);
  assert.equal(h.current.inputBalanceAtomic, '5000000000');
});

test('leaving during wallet approval cannot submit a late signature and releases the draft', async (t) => {
  const h = await createControllerFixture();
  t.after(() => h.dispose());
  await h.run((c) => c.setManualAmount('1'));
  await h.run((c) => c.prepareReview());
  const approval = deferred<VersionedTransaction>();
  h.fixture.signRequest = () => approval.promise;
  const transaction = VersionedTransaction.deserialize(
    Buffer.from(h.current.reviewOrder!.transaction, 'base64'),
  );
  let confirming!: Promise<void>;
  await h.run((c) => {
    confirming = c.confirmTrade();
  });
  await h.update({ active: false });
  approval.resolve(transaction);
  await h.run(() => confirming);
  await h.update({ active: true });
  assert.equal(h.fixture.calls.execute, 0);
  assert.equal(h.current.phase, 'compose');
  assert.equal(h.current.reviewOrder, null);
  await h.run((c) => c.setManualAmount('2'));
  assert.equal(h.current.amount, '2');
});

test('leaving after submission preserves recovery and return never resubmits', async (t) => {
  const h = await createControllerFixture();
  t.after(() => h.dispose());
  await h.run((c) => c.setManualAmount('1'));
  await h.run((c) => c.prepareReview());
  const response = deferred<Awaited<ReturnType<NonNullable<typeof h.fixture.executeRequest>>>>();
  h.fixture.executeRequest = () => response.promise;
  h.fixture.statusError = new Error('Fixture status unavailable');
  let confirming!: Promise<void>;
  await h.run((c) => {
    confirming = c.confirmTrade();
  });
  assert.equal(h.fixture.calls.execute, 1);
  const before = await h.fixture.store.list(h.fixture.wallet.address!);
  await h.update({ active: false });
  response.resolve({
    outcome: 'unknown',
    signature: 'fixture-signature',
    slot: null,
    code: null,
    message: null,
    totalInputAmountAtomic: null,
    totalOutputAmountAtomic: null,
    inputAmountResultAtomic: null,
    outputAmountResultAtomic: null,
  });
  await h.run(() => confirming);
  await h.update({ active: true });
  assert.equal(h.current.phase, 'unknown');
  assert.equal(h.current.pendingReady, false);
  assert.equal(h.fixture.calls.execute, 1);
  const pending = await h.fixture.store.list(h.fixture.wallet.address!);
  assert.equal(pending[0].inAmountAtomic, before[0].inAmountAtomic);
  assert.equal(pending[0].minimumOutAmountAtomic, before[0].minimumOutAmountAtomic);
  h.fixture.statusError = null;
  h.fixture.signatureStatus = { err: null, confirmationStatus: 'confirmed' };
  await h.run((c) => c.reconcilePending());
  assert.equal(h.current.phase, 'confirmed');
  assert.equal(h.fixture.calls.execute, 1);
});

test('a context change during pending persistence cannot start submission', async (t) => {
  const h = await createControllerFixture();
  t.after(() => h.dispose());
  await h.run((c) => c.setManualAmount('1'));
  await h.run((c) => c.prepareReview());
  const persisted = deferred<void>();
  h.fixture.storageWriteRequest = () => persisted.promise;
  let confirming!: Promise<void>;
  await h.run((c) => {
    confirming = c.confirmTrade();
  });
  assert.equal(h.fixture.calls.sign, 1);
  assert.equal(h.fixture.calls.execute, 0);
  await h.update({ active: false });
  h.fixture.storageWriteRequest = null;
  persisted.resolve();
  await h.run(() => confirming);
  assert.equal(h.fixture.calls.execute, 0);
  await h.update({ active: true });
  assert.equal(h.current.reviewOrder, null);
  assert.equal(h.current.phase, 'compose');
  assert.equal((await h.fixture.store.list(h.fixture.wallet.address!)).length, 0);
});

test('pending-store read failure is visible and a manual status check safely retries', async (t) => {
  const h = await createControllerFixture({ active: false });
  t.after(() => h.dispose());
  h.fixture.storageReadError = new Error('Fixture storage unavailable');
  await h.update({ active: true });
  assert.equal(h.current.pendingReady, false);
  assert.match(h.current.pendingError ?? '', /unavailable/);
  await h.run((c) => c.prepareReview());
  assert.equal(h.fixture.calls.orders.length, 0);
  h.fixture.storageReadError = null;
  await h.run((c) => c.reconcilePending());
  assert.equal(h.current.pendingReady, true);
  assert.equal(h.current.pendingError, null);
  assert.equal(h.fixture.calls.execute, 0);
});

test('unmount during wallet approval cannot submit a late signature', async () => {
  const h = await createControllerFixture();
  await h.run((c) => c.setManualAmount('1'));
  await h.run((c) => c.prepareReview());
  const approval = deferred<VersionedTransaction>();
  h.fixture.signRequest = () => approval.promise;
  const transaction = VersionedTransaction.deserialize(
    Buffer.from(h.current.reviewOrder!.transaction, 'base64'),
  );
  let confirming!: Promise<void>;
  await h.run((c) => {
    confirming = c.confirmTrade();
  });
  await h.dispose();
  approval.resolve(transaction);
  await confirming;
  assert.equal(h.fixture.calls.execute, 0);
  assert.equal((await h.fixture.store.list(h.fixture.wallet.address!)).length, 0);
});

test('switching wallet during execution isolates recovery and a late response cannot block the new wallet', async (t) => {
  const h = await createControllerFixture();
  t.after(() => h.dispose());
  await h.run((c) => c.setManualAmount('1'));
  await h.run((c) => c.prepareReview());
  const oldAddress = h.fixture.wallet.address!;
  const response = deferred<Awaited<ReturnType<NonNullable<typeof h.fixture.executeRequest>>>>();
  h.fixture.executeRequest = () => response.promise;
  let confirming!: Promise<void>;
  await h.run((c) => {
    confirming = c.confirmTrade();
  });
  const address = Keypair.generate().publicKey.toBase58();
  h.fixture.wallet = {
    ...h.fixture.wallet,
    address,
    sessionKey: `privy:${address}`,
    source: 'privy',
  } as typeof h.fixture.wallet;
  await h.update();
  assert.equal(h.current.phase, 'compose');
  assert.equal(h.current.pendingReady, true);
  assert.equal(h.current.reviewOrder, null);
  response.resolve({
    outcome: 'confirmed',
    signature: 'fixture-signature',
    slot: '123',
    code: null,
    message: null,
    totalInputAmountAtomic: '1000000000',
    totalOutputAmountAtomic: '150000000',
    inputAmountResultAtomic: '1000000000',
    outputAmountResultAtomic: '150000000',
  });
  await h.run(() => confirming);
  assert.equal(h.current.phase, 'compose');
  assert.equal(h.fixture.calls.refresh, 0);
  assert.equal((await h.fixture.store.list(address)).length, 0);
  assert.equal((await h.fixture.store.list(oldAddress)).length, 1);
  await h.run((c) => c.prepareReview());
  assert.equal(h.current.phase, 'reviewing');
  const newWalletReview = { ...h.current }.reviewOrder;
  assert.equal(newWalletReview?.taker, address);
  assert.equal(h.fixture.calls.execute, 1);
});

test('changing the routed token invalidates locked-side review before any old callback can sign', async (t) => {
  const h = await createControllerFixture({ mode: 'buy', requestedMint: fixtureUsdc });
  t.after(() => h.dispose());
  await h.run((c) => c.setManualAmount('1'));
  await h.run((c) => c.prepareReview());
  const oldConfirm = h.current.confirmTrade;
  const mint = Keypair.generate().publicKey.toBase58();
  h.fixture.tokens.push({
    address: mint,
    symbol: 'TEST',
    name: 'Disposable test token',
    decimals: 6,
  });
  await h.update({ mode: 'buy', requestedMint: mint });
  await h.run(() => oldConfirm());
  assert.equal(h.current.reviewOrder, null);
  assert.equal(h.current.phase, 'compose');
  assert.equal(h.current.outputToken.address, mint);
  assert.equal(h.current.amount, '');
  assert.equal(h.fixture.calls.sign, 0);
  assert.equal(h.fixture.calls.execute, 0);
  assert.equal(h.current.pendingReady, true);
  await h.run((c) => c.setManualAmount('1'));
  await h.run((c) => c.prepareReview());
  const newTokenReview = { ...h.current }.reviewOrder;
  assert.equal(newTokenReview?.outputMint, mint);
});

test('a cancelled preparation can stay unresolved without locking the next compose session', async (t) => {
  const h = await createControllerFixture();
  t.after(() => h.dispose());
  await h.run((c) => c.setManualAmount('1'));
  const oldBalance = deferred<Record<string, string>>();
  h.fixture.balanceRequest = () => oldBalance.promise;
  let oldPreparation!: Promise<void>;
  await h.run((c) => {
    oldPreparation = c.prepareReview();
  });
  await h.update({ active: false });
  h.fixture.balanceRequest = null;
  await h.update({ active: true });
  await h.run((c) => c.setManualAmount('2'));
  assert.equal(h.current.amount, '2');
  await h.run((c) => c.prepareReview());
  const currentRequestId = h.current.reviewOrder?.requestId;
  assert.equal(h.current.phase, 'reviewing');
  oldBalance.resolve({ [fixtureSol]: '1' });
  await h.run(() => oldPreparation);
  assert.equal(h.current.phase, 'reviewing');
  assert.equal(h.current.reviewOrder?.requestId, currentRequestId);
  assert.equal(h.current.reviewOrder?.inAmountAtomic, '2000000000');
});

test('manual pending-status storage failure is reported without rejecting or authorizing a trade', async (t) => {
  const h = await createControllerFixture();
  t.after(() => h.dispose());
  h.fixture.storageReadError = new Error('Fixture manual status storage unavailable');
  await h.run((c) => c.reconcilePending());
  assert.equal(h.current.pendingReady, false);
  assert.match(h.current.pendingError ?? '', /manual status storage unavailable/);
  await h.run((c) => c.prepareReview());
  assert.equal(h.fixture.calls.orders.length, 0);
  assert.equal(h.fixture.calls.execute, 0);
  h.fixture.storageReadError = null;
  await h.run((c) => c.reconcilePending());
  assert.equal(h.current.pendingReady, true);
  assert.equal(h.current.pendingError, null);
});

test('an unresolved swap belongs to its original wallet and cannot restore a review into another wallet', async (t) => {
  const h = await createControllerFixture();
  t.after(() => h.dispose());
  h.fixture.executionOutcome = 'unknown';
  h.fixture.statusError = new Error('Fixture RPC unavailable');
  await h.run((c) => c.setManualAmount('1'));
  await h.run((c) => c.prepareReview());
  const oldAddress = h.fixture.wallet.address!;
  await h.run((c) => c.confirmTrade());
  assert.equal(h.current.phase, 'unknown');
  const originalPending = await h.fixture.store.list(oldAddress);
  const address = Keypair.generate().publicKey.toBase58();
  h.fixture.wallet = {
    ...h.fixture.wallet,
    address,
    sessionKey: `privy:${address}`,
    source: 'privy',
  } as typeof h.fixture.wallet;
  await h.update();
  assert.equal(h.current.phase, 'compose');
  assert.equal(h.current.pendingReady, true);
  assert.equal(h.current.reviewOrder, null);
  assert.equal(h.current.unknownRequestId, null);
  assert.equal(h.current.resultMessage, null);
  assert.deepEqual(await h.fixture.store.list(oldAddress), originalPending);
  assert.equal((await h.fixture.store.list(address)).length, 0);
  assert.equal(h.fixture.calls.execute, 1);
});
