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

test('confirmed native fixture executions refresh balances for the next local draft', async () => {
  const fixture = createNativeSwapFixture('confirmed');
  const getBalances = fixture.dependencies.getWalletBalances!;
  const before = await getBalances(fixture.walletAddress);
  assert.deepEqual(before, {
    [NATIVE_FIXTURE_SOL]: '3000000000',
    [NATIVE_FIXTURE_USDC]: '1000000000',
  });

  const first = await fixture.dependencies.createSwapOrder!({
    inputMint: NATIVE_FIXTURE_SOL,
    outputMint: NATIVE_FIXTURE_USDC,
    amountAtomic: '10000000',
    taker: fixture.walletAddress,
  });
  await fixture.dependencies.executeSwap!({
    signedTransaction: 'fixture',
    requestId: first.requestId,
    lastValidBlockHeight: first.lastValidBlockHeight!,
  });
  assert.deepEqual(await getBalances(fixture.walletAddress), {
    [NATIVE_FIXTURE_SOL]: '2990000000',
    [NATIVE_FIXTURE_USDC]: '1001500000',
  });

  const second = await fixture.dependencies.createSwapOrder!({
    inputMint: NATIVE_FIXTURE_SOL,
    outputMint: NATIVE_FIXTURE_USDC,
    amountAtomic: '10000000',
    taker: fixture.walletAddress,
  });
  await fixture.dependencies.executeSwap!({
    signedTransaction: 'fixture',
    requestId: second.requestId,
    lastValidBlockHeight: second.lastValidBlockHeight!,
  });
  assert.deepEqual(await getBalances(fixture.walletAddress), {
    [NATIVE_FIXTURE_SOL]: '2980000000',
    [NATIVE_FIXTURE_USDC]: '1003000000',
  });
});

test('failed, rejected and unknown native fixture executions do not move balances', async () => {
  const rejected = createNativeSwapFixture('approval-rejected');
  const rejectedBefore = await rejected.dependencies.getWalletBalances!(rejected.walletAddress);
  const rejectedOrder = await rejected.dependencies.createSwapOrder!({
    inputMint: NATIVE_FIXTURE_SOL,
    outputMint: NATIVE_FIXTURE_USDC,
    amountAtomic: '10000000',
    taker: rejected.walletAddress,
  });
  const rejectedTransaction = VersionedTransaction.deserialize(
    Buffer.from(rejectedOrder.transaction!, 'base64'),
  );
  await assert.rejects(
    (rejected.dependencies.wallet!.signTransaction as unknown as (
      value: VersionedTransaction,
    ) => Promise<VersionedTransaction>)(rejectedTransaction),
    /rejected/i,
  );
  assert.deepEqual(
    await rejected.dependencies.getWalletBalances!(rejected.walletAddress),
    rejectedBefore,
  );

  const failed = createNativeSwapFixture('execution-failed');
  const failedBefore = await failed.dependencies.getWalletBalances!(failed.walletAddress);
  const failedOrder = await failed.dependencies.createSwapOrder!({
    inputMint: NATIVE_FIXTURE_SOL,
    outputMint: NATIVE_FIXTURE_USDC,
    amountAtomic: '10000000',
    taker: failed.walletAddress,
  });
  const failedResult = await failed.dependencies.executeSwap!({
    signedTransaction: 'fixture',
    requestId: failedOrder.requestId,
    lastValidBlockHeight: failedOrder.lastValidBlockHeight!,
  });
  assert.equal(failedResult.outcome, 'failed');
  assert.deepEqual(await failed.dependencies.getWalletBalances!(failed.walletAddress), failedBefore);

  const unknown = createNativeSwapFixture('unknown-recovery');
  const unknownBefore = await unknown.dependencies.getWalletBalances!(unknown.walletAddress);
  const unknownOrder = await unknown.dependencies.createSwapOrder!({
    inputMint: NATIVE_FIXTURE_SOL,
    outputMint: NATIVE_FIXTURE_USDC,
    amountAtomic: '10000000',
    taker: unknown.walletAddress,
  });
  const unknownResult = await unknown.dependencies.executeSwap!({
    signedTransaction: 'fixture',
    requestId: unknownOrder.requestId,
    lastValidBlockHeight: unknownOrder.lastValidBlockHeight!,
  });
  assert.equal(unknownResult.outcome, 'unknown');
  assert.deepEqual(await unknown.dependencies.getWalletBalances!(unknown.walletAddress), unknownBefore);

  unknown.setPendingConfirmed();
  assert.deepEqual(await unknown.dependencies.getWalletBalances!(unknown.walletAddress), {
    [NATIVE_FIXTURE_SOL]: '2990000000',
    [NATIVE_FIXTURE_USDC]: '1001500000',
  });
});
