import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { URL } from 'node:url';
import test from 'node:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import ts from 'typescript';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const require = createRequire(import.meta.url);

type RenderProps = Record<string, unknown>;

function host(name: string) {
  const Component = React.forwardRef((props: RenderProps, ref: React.Ref<unknown>) => {
    React.useImperativeHandle(ref, () => ({ scrollTo: () => {} }));
    return React.createElement(name, props, props.children as React.ReactNode);
  });
  Component.displayName = name;
  return Component;
}

function loadOverview() {
  const source = ts.transpileModule(
    readFileSync(new URL('./HomeWalletOverview.tsx', import.meta.url), 'utf8'),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.React,
        esModuleInterop: true,
      },
    },
  ).outputText;
  const exports: { HomeWalletOverview?: React.ComponentType<RenderProps> } = {};
  const View = host('View');
  const ScrollView = host('ScrollView');
  const scrollCalls: unknown[][] = [];
  const AnimatedScrollView = React.forwardRef((props: RenderProps, ref: React.Ref<unknown>) => {
    React.useImperativeHandle(ref, () => ({
      scrollTo: (...args: unknown[]) => scrollCalls.push(args),
    }));
    return React.createElement('AnimatedScrollView', props, props.children as React.ReactNode);
  });
  AnimatedScrollView.displayName = 'AnimatedScrollView';
  const Pressable = host('Pressable');
  const Text = host('Text');
  const RefreshControl = host('RefreshControl');
  const actionRenders: RenderProps[] = [];
  let actionMounts = 0;
  let actionUnmounts = 0;
  function WalletActionPanel(props: RenderProps) {
    actionRenders.push(props);
    React.useEffect(() => {
      actionMounts += 1;
      return () => {
        actionUnmounts += 1;
      };
    }, []);
    return React.createElement('WalletActionPanel', props);
  }
  const Animated = {
    View: host('AnimatedView'),
    ScrollView: AnimatedScrollView,
  };
  // Model shared-value boundary reactions without claiming native animation timing.
  const reactions = new Set<() => void>();
  const reanimated = {
    __esModule: true,
    default: Animated,
    runOnJS: (callback: (...args: unknown[]) => void) => callback,
    useSharedValue: (initial: number) => {
      const ref = React.useRef<{ value: number } | null>(null);
      if (!ref.current) {
        let value = initial;
        ref.current = {
          get value() { return value; },
          set value(next: number) {
            value = next;
            for (const reaction of reactions) reaction();
          },
        };
      }
      return ref.current;
    },
    useAnimatedStyle: (update: () => unknown) => update(),
    useAnimatedScrollHandler: (handlers: { onScroll: (event: unknown) => void }) =>
      (event: { nativeEvent: unknown }) => handlers.onScroll(event.nativeEvent),
    useAnimatedReaction: (
      prepare: () => boolean,
      react: (value: boolean, previous: boolean | null) => void,
      dependencies: React.DependencyList,
    ) => {
      const latest = React.useRef({ prepare, react });
      latest.current = { prepare, react };
      const previous = React.useRef<boolean | null>(null);
      React.useEffect(() => {
        const evaluate = () => {
          const next = latest.current.prepare();
          const before = previous.current;
          previous.current = next;
          latest.current.react(next, before);
        };
        reactions.add(evaluate);
        evaluate();
        return () => { reactions.delete(evaluate); };
      }, dependencies);
    },
  };
  const mocks: Record<string, unknown> = {
    react: React,
    'react-native': {
      Platform: { OS: 'android' },
      Pressable,
      RefreshControl,
      ScrollView,
      StyleSheet: { create: (styles: unknown) => styles },
      Text,
      View,
      useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
    },
    'react-native-reanimated': reanimated,
    '@/features/swap/swap.theme': {
      swapTheme: { navy: '#000', gold: '#fff', dim: '#777', border: '#333', text: '#111', card: '#eee', panelOverlap: 24, composerInset: 14 },
    },
    '@/features/wallet/WalletActionPanel': { WalletActionPanel },
    '@/features/wallet/WalletAccountRow': { WalletAccountRow: () => null },
    '@/features/wallet/PerpsAccountRow': { PerpsAccountRow: () => null },
    '@/features/wallet/components/ChainRow': { ChainRow: () => null },
    '@/features/chain/chain.contract': {},
    '@/features/wallet/wallet.types': {},
  };
  runInNewContext(
    source,
    {
      exports,
      React,
      require: (name: string) => (name in mocks ? mocks[name] : require(name)),
    },
    { filename: 'HomeWalletOverview.fixture.js' },
  );
  return {
    Overview: exports.HomeWalletOverview!,
    View,
    ScrollView,
    AnimatedScrollView,
    actionRenders,
    scrollCalls,
    get actionMounts() {
      return actionMounts;
    },
    get actionUnmounts() {
      return actionUnmounts;
    },
  };
}

function overviewProps(surfaceVersion = 1): RenderProps {
  const source = { valueUsd: null, resolvedAt: null, error: null, loading: false };
  return {
    active: true,
    surfaceVersion,
    chains: [],
    chainAddress: () => null,
    chainBalance: () => null,
    solanaConnected: false,
    onDisconnectChain: () => {},
    walletTotals: { totalUsd: null },
    walletSources: { spot: source, phoenix: source, pacifica: source, meteora: source },
    walletRefreshing: false,
    onWalletRefresh: () => {},
    onRetrySource: () => {},
    onOpenMeteora: () => {},
    onOpenPhoenix: () => {},
    onOpenPacifica: () => {},
    onOpenSpot: () => {},
    onConnect: () => {},
  };
}

test('wallet panel scroll keeps composer mounted and only toggles it at the panel boundary', async () => {
  const loaded = loadOverview();
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(loaded.Overview, overviewProps()));
  });

  const views = renderer.root.findAllByType(loaded.View);
  await act(async () => {
    views[0].props.onLayout({ nativeEvent: { layout: { height: 844 } } });
    views[1].props.onLayout({ nativeEvent: { layout: { height: 500 } } });
  });
  const accountScroll = renderer.root.findByType(loaded.AnimatedScrollView);
  const baselineRenders = loaded.actionRenders.length;
  assert.equal(loaded.actionRenders.at(-1)?.active, true);

  await act(async () => {
    accountScroll.props.onScroll({ nativeEvent: { contentOffset: { y: 100 } } });
    accountScroll.props.onScroll({ nativeEvent: { contentOffset: { y: 300 } } });
  });
  assert.equal(loaded.actionRenders.length, baselineRenders);
  assert.equal(loaded.actionMounts, 1);

  await act(async () => {
    accountScroll.props.onScroll({ nativeEvent: { contentOffset: { y: 474 } } });
  });
  assert.equal(loaded.actionRenders.length, baselineRenders + 1);
  assert.equal(loaded.actionRenders.at(-1)?.active, false);
  assert.equal(loaded.actionMounts, 1);
  assert.equal(loaded.actionUnmounts, 0);

  await act(async () => {
    accountScroll.props.onScroll({ nativeEvent: { contentOffset: { y: 475 } } });
    accountScroll.props.onScroll({ nativeEvent: { contentOffset: { y: 476 } } });
  });
  assert.equal(loaded.actionRenders.length, baselineRenders + 1);

  await act(async () => {
    accountScroll.props.onScroll({ nativeEvent: { contentOffset: { y: 100 } } });
  });
  assert.equal(loaded.actionRenders.length, baselineRenders + 2);
  assert.equal(loaded.actionRenders.at(-1)?.active, true);

  await act(async () => {
    accountScroll.props.onScroll({ nativeEvent: { contentOffset: { y: 474 } } });
  });
  assert.equal(loaded.actionRenders.length, baselineRenders + 3);
  assert.equal(loaded.actionRenders.at(-1)?.active, false);

  await act(async () => {
    renderer.update(React.createElement(loaded.Overview, overviewProps(2)));
  });
  assert.equal(loaded.actionRenders.at(-1)?.active, true);
  const reset = loaded.scrollCalls.at(-1)?.[0] as { y?: number; animated?: boolean };
  assert.equal(reset.y, 0);
  assert.equal(reset.animated, false);
  assert.equal(loaded.actionMounts, 1);
  assert.equal(loaded.actionUnmounts, 0);
});
