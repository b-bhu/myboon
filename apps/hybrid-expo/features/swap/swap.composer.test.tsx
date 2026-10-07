import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { URL } from 'node:url';
import test from 'node:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import ts from 'typescript';
import * as math from './swap.math';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const require = createRequire(import.meta.url);
const sol: Record<string, unknown> = {
  address: 'So11111111111111111111111111111111111111112',
  symbol: 'SOL',
  name: 'Solana',
  decimals: 9,
};
const usdc: Record<string, unknown> = {
  address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  symbol: 'USDC',
  name: 'USD Coin',
  decimals: 6,
};

function order(requestId: string, kind: 'quote' | 'signable' = 'quote') {
  return {
    kind,
    requestId,
    inputMint: sol.address,
    outputMint: usdc.address,
    inAmountAtomic: '1000000000',
    outAmountAtomic: '150000000',
    minimumOutAmountAtomic: '149250000',
    inUsdValue: 150,
    outUsdValue: 150,
    priceImpactPct: 0.02,
    slippageBps: 50,
    router: 'metis' as const,
    route: [{ label: 'Fixture route', percent: 100 }],
    fees: {
      providerFeeBps: 0,
      providerFeeAtomic: '0',
      providerFeeMint: sol.address,
      signatureFeeLamports: '5000',
      priorityFeeLamports: '0',
      rentFeeLamports: '0',
      myboonFeeAtomic: '0' as const,
      gasless: false,
    },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    taker: kind === 'signable' ? 'fixture-wallet' : null,
    transaction: kind === 'signable' ? 'fixture-transaction' : null,
    lastValidBlockHeight: kind === 'signable' ? '1000' : null,
  };
}

function containsText(value: unknown, text: string): boolean {
  if (value === text) return true;
  if (Array.isArray(value)) return value.some((item) => containsText(item, text));
  if (value && typeof value === 'object' && 'props' in value) {
    return containsText((value as { props?: { children?: unknown } }).props?.children, text);
  }
  return false;
}

function createFakeTimers() {
  let nextId = 1;
  const callbacks = new Map<number, () => void>();
  const delays = new Map<number, number>();
  return {
    setTimeout(callback: () => void, delay: number) {
      const id = nextId++;
      callbacks.set(id, callback);
      delays.set(id, delay);
      return id;
    },
    clearTimeout(handle: unknown) {
      callbacks.delete(Number(handle));
      delays.delete(Number(handle));
    },
    fire(delay?: number) {
      for (const [id, callback] of [...callbacks.entries()]) {
        if (delay !== undefined && delays.get(id) !== delay) continue;
        callbacks.delete(id);
        delays.delete(id);
        callback();
      }
    },
    pending(delay?: number) {
      return [...delays.values()].filter((value) => delay === undefined || value === delay).length;
    },
  };
}

type ComposerTimers = ReturnType<typeof createFakeTimers>;

function loadComposer(timers?: Pick<ComposerTimers, 'setTimeout' | 'clearTimeout'>) {
  const source = ts.transpileModule(
    readFileSync(new URL('./components/SwapComposer.tsx', import.meta.url), 'utf8'),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.React,
        esModuleInterop: true,
      },
    },
  ).outputText;
  const exports: { SwapComposer?: React.ComponentType<Record<string, unknown>> } = {};
  const AssetSwap = (props: Record<string, unknown>) =>
    React.createElement('AssetSwap', props, props.children as React.ReactNode);
  const SwapTokenAvatar = () => React.createElement('SwapTokenAvatar');
  const SwipeToConfirm = (props: Record<string, unknown>) =>
    React.createElement('SwipeToConfirm', props);
  const WalletSecondarySheet = (props: Record<string, unknown>) =>
    React.createElement('WalletSecondarySheet', props, props.children as React.ReactNode);
  const host = (name: string) => {
    const Component = React.forwardRef((props: Record<string, unknown>, ref: React.Ref<unknown>) =>
      React.createElement(name, { ...props, ref }, props.children as React.ReactNode),
    );
    Component.displayName = name;
    return Component;
  };
  const mocks: Record<string, unknown> = {
    react: React,
    '@expo/vector-icons/MaterialIcons': () => React.createElement('MaterialIcons'),
    'react-native': {
      AccessibilityInfo: {
        announceForAccessibility: async () => {},
        setAccessibilityFocus: () => {},
      },
      ActivityIndicator: host('ActivityIndicator'),
      Animated: { View: host('AnimatedView') },
      findNodeHandle: () => null,
      Keyboard: { dismiss: () => {}, addListener: () => ({ remove: () => {} }) },
      Pressable: host('Pressable'),
      StyleSheet: { create: (styles: unknown) => styles, absoluteFillObject: {} },
      Text: host('Text'),
      TextInput: host('TextInput'),
      View: host('View'),
    },
    '@/features/swap/components/AssetSwap': { AssetSwap, SwapTokenAvatar },
    '@/features/swap/components/SwapTokenPicker': { SwapTokenPicker: () => null },
    '@/features/swap/components/SwipeToConfirm': { SwipeToConfirm },
    '@/features/swap/swap.math': math,
    '@/features/swap/swap.motion': {
      useSwapValueAnimation: () => ({ opacity: 1, transform: [] }),
    },
    '@/features/swap/swap.display': {
      exchangeRate: () => '1 SOL = 1.5 USDC',
      exchangeRateValue: () => 1.5,
      providerFee: () => '0 USDC',
    },
    '@/features/swap/swap.theme': {
      swapTheme: {
        navy: '#000', gold: '#fff', dim: '#777', border: '#333', text: '#111',
        positive: '#0a0', error: '#a00', card: '#eee',
      },
    },
    '@/features/swap/useSwapController': {
      sumAtomicStrings: (...values: (string | null)[]) =>
        values.reduce((sum, value) => sum + BigInt(value ?? '0'), 0n).toString(),
    },
    '@/features/wallet/WalletSheetProvider': { useWalletSheet: () => ({ isOpen: false, open: () => {}, close: () => {} }) },
    '@/features/wallet/WalletSecondarySheet': { WalletSecondarySheet },
    '@/features/wallet/wallet-action-gesture': {
      WALLET_ACTION_MENU: [
        { id: 'swap', label: 'Swap' },
        { id: 'send', label: 'Send' },
        { id: 'receive', label: 'Receive' },
        { id: 'transfer', label: 'Transfer' },
      ],
      createReverseGesture: () => ({ handleTap: () => {}, cancel: () => {}, dispose: () => {}, update: () => {} }),
    },
  };
  runInNewContext(
    source,
    {
      exports,
      React,
      require: (name: string) => (name in mocks ? mocks[name] : require(name)),
      setTimeout: timers?.setTimeout ?? setTimeout,
      clearTimeout: timers?.clearTimeout ?? clearTimeout,
      requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
    },
    { filename: 'SwapComposer.fixture.js' },
  );
  return { SwapComposer: exports.SwapComposer!, AssetSwap, SwipeToConfirm };
}

function controller(overrides: Record<string, unknown> = {}) {
  const calls = { prepare: 0, confirm: 0, sign: 0, execute: 0, invalidate: 0 };
  const c: Record<string, unknown> = {
    mode: 'swap', wallet: { connected: true, address: 'fixture-wallet' },
    inputToken: sol, outputToken: usdc, selectedToken: null, amount: '1', phase: 'compose',
    pickerSide: 'input', tokenQuery: '', tokenResults: [], tokenLoading: false, tokenError: null,
    balances: { [sol.address as string]: '3000000000' }, balancesResolved: true, balancesError: null,
    pendingReady: true, pendingError: null, prices: {}, quote: order('quote-1'), quoteExpired: false,
    quoteError: null, reviewOrder: null, simulationWarning: null, simulationWarningAccepted: false,
    slippageMode: 'auto', customSlippage: '0.5', customSlippageError: null, slippageBps: undefined,
    extremeConfirmation: '', failure: null, unknownRequestId: null, resultMessage: null,
    amountAtomic: '1000000000', inputUsd: 150, outputUi: '150', outputUsd: 150,
    balanceError: null, receiveAtLeast: '149.25', inputBalanceAtomic: '3000000000',
    outputBalanceAtomic: '1000000000', isDangerousSlippage: false, isExtremeSlippage: false,
    interactionBusy: false, tradeInteractionBusy: false,
    prepareReview: async () => { calls.prepare += 1; },
    confirmTrade: async () => { calls.confirm += 1; },
    invalidatePreparedTrade: () => { calls.invalidate += 1; return true; },
    setManualAmount: () => {}, openPicker: () => {}, selectToken: () => {}, cancelPicker: () => {},
    setTokenQuery: () => {}, reversePair: () => {}, retry: () => {}, retryBalances: async () => {},
    setSlippageMode: () => {}, setCustomSlippage: () => {}, setExtremeConfirmation: () => {},
    setSimulationWarningAccepted: () => {}, balancePercent: () => {}, setBalancePercent: () => {},
    reconcilePending: async () => {},
    ...overrides,
  };
  return { c, calls };
}

async function renderComposer(
  c: Record<string, unknown>,
  options: { active?: boolean; surfaceKey?: string; walletActions?: boolean; timers?: ComposerTimers } = {},
) {
  const loaded = loadComposer(options.timers);
  const composer = loaded.SwapComposer;
  const swipe = loaded.SwipeToConfirm;
  const assetSwap = loaded.AssetSwap;
  let renderer!: ReactTestRenderer;
  const walletSheet = { isOpen: false, open: () => {}, close: () => {} };
  let active = options.active ?? true;
  let surfaceKey = options.surfaceKey ?? 'swap';
  const walletActions = options.walletActions ?? false;
  await act(async () => {
    renderer = create(
        React.createElement(composer, {
        active,
        surfaceKey,
        onBusyChange: () => {},
        controller: c,
        walletSheet,
        walletActions,
      }),
    );
  });
  return {
    renderer,
    AssetSwap: assetSwap,
    SwipeToConfirm: swipe,
    async update(
      next: Record<string, unknown>,
      updateOptions: { active?: boolean; surfaceKey?: string } = {},
    ) {
      if (updateOptions.active !== undefined) active = updateOptions.active;
      if (updateOptions.surfaceKey !== undefined) surfaceKey = updateOptions.surfaceKey;
      await act(async () => {
        renderer.update(
          React.createElement(composer, {
            active,
            surfaceKey,
            onBusyChange: () => {},
            controller: next,
            walletSheet,
            walletActions,
          }),
        );
      });
    },
    async settle() {
      await act(async () => { await Promise.resolve(); });
    },
    async dispose() {
      await act(async () => renderer.unmount());
    },
  };
}

test('valid quote prepares once and only an explicit swipe confirms the exact review', async () => {
  const { SwapComposer, SwipeToConfirm } = loadComposer();
  const first = controller();
  let renderer!: ReactTestRenderer;
  const walletSheet = { isOpen: false, open: () => {}, close: () => {} };
  const render = (c: Record<string, unknown>) => React.createElement(SwapComposer, {
    active: true, surfaceKey: 'swap', onBusyChange: () => {}, controller: c, walletSheet, walletActions: false,
  });
  await act(async () => { renderer = create(render(first.c)); });
  await act(async () => { await Promise.resolve(); });
  assert.equal(first.calls.prepare, 1);
  assert.equal(first.calls.confirm, 0);
  assert.equal(first.calls.sign, 0);
  assert.equal(first.calls.execute, 0);
  await act(async () => { renderer.update(render(first.c)); });
  assert.equal(first.calls.prepare, 1);

  const reviewed = controller({ phase: 'reviewing', quote: order('quote-1'), reviewOrder: order('order-1', 'signable') });
  await act(async () => { renderer.update(render(reviewed.c)); });
  assert.equal(renderer.root.findAllByType(SwipeToConfirm).length, 1);
  assert.equal(reviewed.calls.confirm, 0);
  assert.equal(reviewed.calls.sign, 0);
  assert.equal(reviewed.calls.execute, 0);
  renderer.root.findByType(SwipeToConfirm).props.onComplete();
  await act(async () => { await Promise.resolve(); });
  assert.equal(reviewed.calls.confirm, 1);
  await act(async () => renderer.unmount());
});

test('closing an action surface re-prepares the same quote request after invalidation', async () => {
  const initial = controller();
  const h = await renderComposer(initial.c, { walletActions: true });
  await h.settle();
  assert.equal(initial.calls.prepare, 1);

  const reviewed = controller({
    phase: 'reviewing',
    quote: order('quote-1'),
    reviewOrder: order('order-1', 'signable'),
  });
  await h.update(reviewed.c);
  const actionHeading = h.renderer.root.findByProps({
    accessibilityLabel: 'Swap, choose wallet action',
  });
  await act(async () => actionHeading.props.onPress());

  const composeAgain = controller({ phase: 'compose', quote: order('quote-1') });
  await h.update(composeAgain.c);
  const actionSheet = h.renderer.root.findByProps({ title: 'Wallet actions' });
  await act(async () => actionSheet.props.onClose());
  await h.settle();
  assert.equal(composeAgain.calls.prepare, 1);
  await h.dispose();
});

test('review swipe stays disabled while pending reconciliation is unresolved', async () => {
  const h = await renderComposer(
    controller({
      phase: 'reviewing',
      pendingReady: false,
      quote: order('quote-1'),
      reviewOrder: order('order-1', 'signable'),
    }).c,
  );
  assert.equal(h.renderer.root.findAllByType(h.SwipeToConfirm).length, 0);
  await h.dispose();
});

test('mismatched prepared draft cannot expose swipe, then a refreshed session can', async () => {
  const pairMismatch = await renderComposer(
    controller({
      phase: 'reviewing',
      inputToken: usdc,
      outputToken: sol,
      quote: order('quote-1'),
      reviewOrder: order('order-1', 'signable'),
    }).c,
  );
  assert.equal(pairMismatch.renderer.root.findAllByType(pairMismatch.SwipeToConfirm).length, 0);
  await pairMismatch.dispose();

  const amountMismatch = await renderComposer(
    controller({
      phase: 'reviewing',
      amount: '2',
      amountAtomic: '2000000000',
      quote: order('quote-1'),
      reviewOrder: order('order-1', 'signable'),
    }).c,
  );
  assert.equal(amountMismatch.renderer.root.findAllByType(amountMismatch.SwipeToConfirm).length, 0);
  await amountMismatch.dispose();

  const original = controller({
    phase: 'reviewing',
    quote: order('quote-1'),
    reviewOrder: order('order-1', 'signable'),
  });
  const h = await renderComposer(original.c);
  assert.equal(h.renderer.root.findAllByType(h.SwipeToConfirm).length, 1);

  const changedSession = controller({
    phase: 'reviewing',
    wallet: { connected: true, address: 'fixture-wallet', sessionKey: 'session-2' },
    quote: order('quote-1'),
    reviewOrder: order('order-1', 'signable'),
  });
  await h.update(changedSession.c);
  assert.equal(h.renderer.root.findAllByType(h.SwipeToConfirm).length, 0);

  const refreshedCompose = controller({
    phase: 'compose',
    wallet: { connected: true, address: 'fixture-wallet', sessionKey: 'session-2' },
    quote: order('quote-2'),
  });
  await h.update(refreshedCompose.c);
  await h.settle();
  const refreshedReview = controller({
    phase: 'reviewing',
    wallet: { connected: true, address: 'fixture-wallet', sessionKey: 'session-2' },
    quote: order('quote-2'),
    reviewOrder: order('order-2', 'signable'),
  });
  await h.update(refreshedReview.c);
  assert.equal(h.renderer.root.findAllByType(h.SwipeToConfirm).length, 1);
  await h.dispose();
});

test('expired, insufficient, pending and unconfirmed extreme-slippage quotes do not auto-prepare', async (t) => {
  const cases = [
    { label: 'expired', quoteExpired: true },
    { label: 'insufficient', balanceError: 'Balance too low' },
    { label: 'pending', pendingReady: false },
    { label: 'extreme', isExtremeSlippage: true },
  ];
  for (const [index, item] of cases.entries()) {
    const h = await renderComposer(controller({ quote: order(`gate-${index}`), ...item }).c);
    t.after(() => h.dispose());
    await h.settle();
    assert.equal((h.renderer.root.findAllByType(h.SwipeToConfirm)).length, 0, item.label);
  }
});

test('review expiry disables swipe until a fresh nonexpired review is supplied', async () => {
  const h = await renderComposer(
    controller({ phase: 'reviewing', quoteExpired: true, reviewOrder: order('order-1', 'signable') }).c,
  );
  assert.equal(h.renderer.root.findAllByType(h.SwipeToConfirm).length, 0);
  const next = controller({ phase: 'reviewing', quoteExpired: false, reviewOrder: order('order-2', 'signable') });
  await h.update(next.c);
  assert.equal(h.renderer.root.findAllByType(h.SwipeToConfirm).length, 1);
  h.renderer.root.findByType(h.SwipeToConfirm).props.onComplete();
  await h.settle();
  assert.equal(next.calls.confirm, 1);
  await h.dispose();
});

test('read-only swap details dialog preserves the prepared review and restores swipe on close', async () => {
  const reviewedOrder = { ...order('order-details', 'signable'), priceImpactPct: 1.23456 };
  const state = controller({ phase: 'reviewing', quote: order('quote-details'), reviewOrder: reviewedOrder });
  const h = await renderComposer(state.c);
  assert.equal(h.renderer.root.findAllByType(h.SwipeToConfirm).length, 1);
  const assetSwap = h.renderer.root.findByType(h.AssetSwap);
  assert.equal(assetSwap.props.amount, '1');
  assert.equal(state.c.reviewOrder, reviewedOrder);
  assert.equal(state.calls.prepare, 0);
  assert.equal(state.calls.confirm, 0);
  assert.equal(state.calls.sign, 0);
  assert.equal(state.calls.execute, 0);
  assert.equal(state.calls.invalidate, 0);
  const detailsButton = h.renderer.root.findByProps({ accessibilityLabel: 'Swap fees and route details' });
  await act(async () => detailsButton.props.onPress());

  const dialog = h.renderer.root.findByProps({ title: 'Swap details' });
  assert.equal(dialog.props.presentation, 'dialog');
  assert.equal(h.renderer.root.findAllByType(h.SwipeToConfirm).length, 0);
  assert.equal(containsText(assetSwap.props.children, 'Price impact'), false);
  assert.ok(h.renderer.root.findAll((node) => node.props.children === 'Price impact').length > 0);
  assert.ok(h.renderer.root.findAll((node) => node.props.children === '1.23%').length > 0);
  assert.equal(h.renderer.root.findAll((node) => node.props.children === '1.23456%').length, 0);
  assert.equal(state.c.reviewOrder, reviewedOrder);
  assert.equal(state.calls.prepare, 0);
  assert.equal(state.calls.confirm, 0);
  assert.equal(state.calls.sign, 0);
  assert.equal(state.calls.execute, 0);
  assert.equal(state.calls.invalidate, 0);

  await act(async () => dialog.props.onClose());
  assert.equal(h.renderer.root.findAllByType(h.SwipeToConfirm).length, 1);
  assert.equal(h.renderer.root.findByType(h.AssetSwap).props.amount, '1');
  assert.equal(state.c.reviewOrder, reviewedOrder);
  assert.equal(state.calls.prepare, 0);
  assert.equal(state.calls.confirm, 0);
  assert.equal(state.calls.sign, 0);
  assert.equal(state.calls.execute, 0);
  assert.equal(state.calls.invalidate, 0);
  await h.dispose();
});

test('closing details cannot rearm an expired or stale review', async () => {
  const cases = [
    { quoteExpired: true },
    { inputToken: usdc, outputToken: sol },
  ];
  for (const overrides of cases) {
    const state = controller({
      phase: 'reviewing',
      quote: order('quote-stale'),
      reviewOrder: order('order-stale', 'signable'),
      ...overrides,
    });
    const h = await renderComposer(state.c);
    assert.equal(h.renderer.root.findAllByType(h.SwipeToConfirm).length, 0);
    const detailsButton = h.renderer.root.findByProps({ accessibilityLabel: 'Swap fees and route details' });
    await act(async () => detailsButton.props.onPress());
    const dialog = h.renderer.root.findByProps({ title: 'Swap details' });
    await act(async () => dialog.props.onClose());
    assert.equal(h.renderer.root.findAllByType(h.SwipeToConfirm).length, 0);
    assert.equal(state.calls.prepare, 0);
    assert.equal(state.calls.confirm, 0);
    assert.equal(state.calls.sign, 0);
    assert.equal(state.calls.execute, 0);
    assert.equal(state.calls.invalidate, 0);
    await h.dispose();
  }

  const current = controller({
    phase: 'reviewing',
    quote: order('quote-current'),
    reviewOrder: order('order-current', 'signable'),
  });
  const h = await renderComposer(current.c);
  assert.equal(h.renderer.root.findAllByType(h.SwipeToConfirm).length, 1);
  const detailsButton = h.renderer.root.findByProps({ accessibilityLabel: 'Swap fees and route details' });
  await act(async () => detailsButton.props.onPress());
  const stale = controller({
    phase: 'reviewing',
    quoteExpired: true,
    inputToken: usdc,
    outputToken: sol,
    quote: order('quote-current'),
    reviewOrder: order('order-current', 'signable'),
  });
  await h.update(stale.c);
  const dialog = h.renderer.root.findByProps({ title: 'Swap details' });
  await act(async () => dialog.props.onClose());
  assert.equal(h.renderer.root.findAllByType(h.SwipeToConfirm).length, 0);
  assert.equal(stale.calls.prepare, 0);
  assert.equal(stale.calls.confirm, 0);
  assert.equal(stale.calls.sign, 0);
  assert.equal(stale.calls.execute, 0);
  assert.equal(stale.calls.invalidate, 0);
  await h.dispose();
});

test('confirmed amount edit clears the old review and enables a separately confirmed second draft', async () => {
  const edits: string[] = [];
  const initial = controller({ phase: 'confirmed', quote: order('order-1', 'signable'), reviewOrder: order('order-1', 'signable') });
  initial.c.setManualAmount = (value: string) => edits.push(value);
  const h = await renderComposer(initial.c);
  assert.equal(h.renderer.root.findAllByType(h.SwipeToConfirm).length, 0);
  h.renderer.root.findByType(h.AssetSwap).props.onAmount('2');
  assert.deepEqual(edits, ['2']);
  const next = controller({ amount: '2', amountAtomic: '2000000000', quote: order('quote-2'), phase: 'compose' });
  await h.update(next.c);
  await h.settle();
  assert.equal(next.calls.prepare, 1);
  assert.equal(next.calls.confirm, 0);
  const reviewed = controller({ amount: '2', amountAtomic: '2000000000', phase: 'reviewing', quote: order('quote-2'), reviewOrder: { ...order('order-2', 'signable'), inAmountAtomic: '2000000000' } });
  await h.update(reviewed.c);
  h.renderer.root.findByType(h.SwipeToConfirm).props.onComplete();
  await h.settle();
  assert.equal(reviewed.calls.confirm, 1);
  await h.dispose();
});

test('empty draft hides quote controls and entering an amount reveals them', async () => {
  const empty = controller({ amount: '', amountAtomic: null, quote: null });
  const h = await renderComposer(empty.c);
  assert.equal(h.renderer.root.findAllByProps({ accessibilityLabel: 'Slippage settings' }).length, 0);
  assert.equal(
    h.renderer.root.findAll((node) =>
      typeof node.props.accessibilityLabel === 'string' &&
      node.props.accessibilityLabel.startsWith('Minimum received'),
    ).length,
    0,
  );
  assert.equal(
    h.renderer.root.findAll((node) =>
      typeof node.props.accessibilityLabel === 'string' &&
      node.props.accessibilityLabel.includes(' = '),
    ).length,
    0,
  );

  const entered = controller({ amount: '1', amountAtomic: '1000000000', quote: order('quote-entered') });
  await h.update(entered.c);
  await h.settle();
  assert.ok(h.renderer.root.findAllByProps({ accessibilityLabel: 'Slippage settings' }).length > 0);
  assert.ok(
    h.renderer.root.findAll((node) =>
      typeof node.props.accessibilityLabel === 'string' &&
      node.props.accessibilityLabel.startsWith('Minimum received'),
    ).length > 0,
  );
  assert.ok(
    h.renderer.root.findAll((node) =>
      typeof node.props.accessibilityLabel === 'string' &&
      node.props.accessibilityLabel.includes(' = '),
    ).length > 0,
  );
  await h.dispose();
});

test('focused amount defers auto preparation until blur', async () => {
  const empty = controller({ amount: '', amountAtomic: null, quote: null });
  const h = await renderComposer(empty.c);
  await act(async () => h.renderer.root.findByType(h.AssetSwap).props.onAmountFocus());

  const entered = controller({ amount: '1', amountAtomic: '1000000000', quote: order('quote-focused') });
  await h.update(entered.c);
  await h.settle();
  assert.equal(entered.calls.prepare, 0);
  assert.equal(entered.calls.confirm, 0);

  await act(async () => h.renderer.root.findByType(h.AssetSwap).props.onAmountBlur());
  await h.settle();
  assert.equal(entered.calls.prepare, 1);
  assert.equal(entered.calls.confirm, 0);
  await h.dispose();
});

test('timed success invalidates once, keeps the amount, and starts a fresh read-only preview', async () => {
  const timers = createFakeTimers();
  const initial = controller();
  const h = await renderComposer(initial.c, { timers });
  await h.settle();
  assert.equal(initial.calls.prepare, 1);
  const confirmed = { ...initial.c, phase: 'confirmed', resultMessage: 'Balances refreshed.' };
  await h.update(confirmed);
  assert.equal(timers.pending(2400), 1);
  timers.fire(2400);
  await h.settle();
  assert.equal(initial.calls.invalidate, 1);
  assert.equal(initial.calls.confirm, 0);
  assert.equal(initial.calls.sign, 0);
  assert.equal(initial.calls.execute, 0);

  const fresh = controller({ amount: '1', amountAtomic: '1000000000', quote: order('quote-1'), phase: 'compose' });
  await h.update(fresh.c);
  await h.settle();
  assert.equal(fresh.c.amount, '1');
  assert.equal(fresh.calls.prepare, 1);
  assert.equal(fresh.calls.confirm, 0);
  assert.equal(fresh.calls.sign, 0);
  assert.equal(fresh.calls.execute, 0);
  await h.dispose();
});

test('success reset timer pauses while details are open and reschedules on close', async () => {
  const timers = createFakeTimers();
  const reviewedOrder = order('order-details-success', 'signable');
  const state = controller({
    phase: 'confirmed',
    quote: reviewedOrder,
    reviewOrder: reviewedOrder,
    resultMessage: 'Balances refreshed.',
  });
  const h = await renderComposer(state.c, { timers });
  assert.equal(timers.pending(2400), 1);

  const detailsButton = h.renderer.root.findByProps({ accessibilityLabel: 'Swap fees and route details' });
  await act(async () => detailsButton.props.onPress());
  assert.equal(timers.pending(2400), 0);
  assert.equal(h.renderer.root.findByProps({ title: 'Swap details' }).props.presentation, 'dialog');
  assert.equal(state.c.reviewOrder, reviewedOrder);
  assert.equal(state.calls.invalidate, 0);
  assert.equal(state.calls.confirm, 0);
  assert.equal(state.calls.sign, 0);
  assert.equal(state.calls.execute, 0);

  const dialog = h.renderer.root.findByProps({ title: 'Swap details' });
  await act(async () => dialog.props.onClose());
  assert.equal(timers.pending(2400), 1);
  timers.fire(2400);
  await h.settle();
  assert.equal(state.calls.invalidate, 1);
  assert.equal(state.calls.confirm, 0);
  assert.equal(state.calls.sign, 0);
  assert.equal(state.calls.execute, 0);
  await h.dispose();
});

test('success timer is cleaned up by edit, inactivity, and unmount', async () => {
  for (const cleanup of ['edit', 'inactive', 'unmount'] as const) {
    const timers = createFakeTimers();
    const initial = controller();
    const h = await renderComposer(initial.c, { timers });
    await h.settle();
    await h.update({ ...initial.c, phase: 'confirmed' });
    assert.equal(timers.pending(2400), 1, cleanup);
    if (cleanup === 'edit') {
      await h.update(controller({ amount: '2', amountAtomic: '2000000000', quote: order('quote-edit') }).c);
    } else if (cleanup === 'inactive') {
      await h.update({ ...initial.c, phase: 'confirmed' }, { active: false });
    } else {
      await h.dispose();
    }
    timers.fire(2400);
    await h.settle();
    assert.equal(initial.calls.invalidate, 0, cleanup);
  }
});
