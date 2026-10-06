import assert from 'node:assert/strict';
import test from 'node:test';
import { VersionedTransaction } from '@solana/web3.js';
import {
  createNativeSwapFixture,
  NATIVE_FIXTURE_SOL,
  NATIVE_FIXTURE_USDC,
  SWAP_NATIVE_FIXTURE_CASES,
} from './swap.native-fixture';

test('native verification fixtures provide every I/O seam without production fallbacks', async () => {
  for (const { id } of SWAP_NATIVE_FIXTURE_CASES) {
    const fixture = createNativeSwapFixture(id);
    const dependencies = fixture.dependencies;
    assert.ok(dependencies.wallet);
    assert.equal(
      dependencies.wallet.address,
      id === 'guest' || id === 'evm-only' ? null : fixture.walletAddress,
    );
    assert.ok(dependencies.pendingStore);
    assert.ok(dependencies.rpc);
    assert.ok(dependencies.createSwapOrder);
    assert.ok(dependencies.executeSwap);
    assert.ok(dependencies.getWalletBalances);
    assert.ok(dependencies.validateSwapTransactionForSigning);
    assert.ok(dependencies.simulateValidatedSwap);
    assert.ok(dependencies.finalizeWalletSignedSwapTransaction);

    const quoteRequest = {
      inputMint: NATIVE_FIXTURE_SOL,
      outputMint: NATIVE_FIXTURE_USDC,
      amountAtomic: '100000000',
    };
    if (id === 'quote-failed') {
      await assert.rejects(dependencies.createSwapOrder!(quoteRequest), /quote service unavailable/i);
    } else {
      const quote = await dependencies.createSwapOrder!(quoteRequest);
      assert.equal(quote.kind, 'quote');
    }
    const balances = await dependencies.getWalletBalances!(fixture.walletAddress).catch(() => null);
    if (id !== 'balances-failed') assert.equal(balances?.[NATIVE_FIXTURE_SOL], '3000000000');
    await dependencies.searchSwapTokens!('SOL');
    await dependencies.fetchTokenPrices!([NATIVE_FIXTURE_SOL, NATIVE_FIXTURE_USDC]);
    dependencies.walletSheet!.open('solana');
    dependencies.notifyWalletDataChanged!();
    assert.equal(fixture.getCallCounts().order, 0);
    assert.equal(fixture.getCallCounts().execute, 0);
    assert.equal(fixture.getCallCounts().search, 1);
    assert.equal(fixture.getCallCounts().prices, 1);
    assert.equal(fixture.getCallCounts().walletSheet, 1);
    assert.equal(fixture.getCallCounts().refresh, 1);
  }
});

test('fixture approval and pending recovery remain local and deterministic', async () => {
  const rejected = createNativeSwapFixture('approval-rejected');
  await assert.rejects(
    (rejected.dependencies.wallet!.signTransaction as unknown as (value: unknown) => Promise<unknown>)(
      null,
    ),
    /rejected/i,
  );
  assert.equal(rejected.getCallCounts().sign, 1);

  const recovery = createNativeSwapFixture('unknown-recovery');
  const statusBefore = await recovery.dependencies.rpc!.getSignatureStatuses(['fixture-signature'], {
    searchTransactionHistory: true,
  }).catch(() => null);
  assert.equal(statusBefore, null);
  recovery.setPendingConfirmed();
  const statusAfter = await recovery.dependencies.rpc!.getSignatureStatuses(['fixture-signature'], {
    searchTransactionHistory: true,
  });
  assert.equal(statusAfter.value[0]?.confirmationStatus, 'confirmed');
});

test('fixture telemetry publishes quote, signing and execution updates and disposes cleanly', async () => {
  const fixture = createNativeSwapFixture('confirmed');
  const snapshots: string[] = [];
  const unsubscribe = fixture.subscribe(() => snapshots.push(fixture.getCallCountsSnapshot()));
  await fixture.dependencies.createSwapOrder!({
    inputMint: NATIVE_FIXTURE_SOL,
    outputMint: NATIVE_FIXTURE_USDC,
    amountAtomic: '100000000',
  });
  const signable = await fixture.dependencies.createSwapOrder!({
    inputMint: NATIVE_FIXTURE_SOL,
    outputMint: NATIVE_FIXTURE_USDC,
    amountAtomic: '100000000',
    taker: fixture.walletAddress,
  });
  const unsigned = VersionedTransaction.deserialize(Buffer.from(signable.transaction!, 'base64'));
  await (fixture.dependencies.wallet!.signTransaction as unknown as (
    value: VersionedTransaction,
  ) => Promise<VersionedTransaction>)(unsigned);
  await fixture.dependencies.executeSwap!({
    signedTransaction: 'fixture',
    requestId: signable.requestId,
    lastValidBlockHeight: signable.lastValidBlockHeight!,
  });
  assert.ok(snapshots.some((snapshot) => JSON.parse(snapshot).quote === 1));
  assert.ok(snapshots.some((snapshot) => JSON.parse(snapshot).sign === 1));
  assert.ok(snapshots.some((snapshot) => JSON.parse(snapshot).execute === 1));
  const beforeDispose = snapshots.length;
  unsubscribe();
  await fixture.dependencies.createSwapOrder!({
    inputMint: NATIVE_FIXTURE_SOL,
    outputMint: NATIVE_FIXTURE_USDC,
    amountAtomic: '200000000',
  });
  assert.equal(snapshots.length, beforeDispose);
});

test('fixture confirmed totals preserve exact reviewed amounts in either pair direction', async () => {
  const fixture = createNativeSwapFixture('confirmed');
  const solToUsdc = await fixture.dependencies.createSwapOrder!({
    inputMint: NATIVE_FIXTURE_SOL,
    outputMint: NATIVE_FIXTURE_USDC,
    amountAtomic: '10000000',
    taker: fixture.walletAddress,
  });
  const forward = await fixture.dependencies.executeSwap!({
    signedTransaction: 'fixture',
    requestId: solToUsdc.requestId,
    lastValidBlockHeight: solToUsdc.lastValidBlockHeight!,
  });
  assert.equal(forward.totalInputAmountAtomic, '10000000');
  assert.equal(forward.totalOutputAmountAtomic, '1500000');

  const usdcToSol = await fixture.dependencies.createSwapOrder!({
    inputMint: NATIVE_FIXTURE_USDC,
    outputMint: NATIVE_FIXTURE_SOL,
    amountAtomic: '1500000',
    taker: fixture.walletAddress,
  });
  const reverse = await fixture.dependencies.executeSwap!({
    signedTransaction: 'fixture',
    requestId: usdcToSol.requestId,
    lastValidBlockHeight: usdcToSol.lastValidBlockHeight!,
  });
  assert.equal(reverse.totalInputAmountAtomic, '1500000');
  assert.equal(reverse.totalOutputAmountAtomic, '10000000');
});
