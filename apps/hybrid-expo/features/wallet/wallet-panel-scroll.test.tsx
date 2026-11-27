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

function loadOverview(lift: { keyboardLiftPx?: number } = {}) {
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
  const ModeSwitchHost = host('WalletModeSwitch');
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
  // #805: the keyboard hook is mocked, so this harness never loads react-native
  // or the keyboard library. Stable identities keep MemoActionPanel's memo
  // behaviour exactly as in production (the real hook returns stable refs too).
  const keyboardLiftStyle = { transform: [{ translateY: lift.keyboardLiftPx ? -lift.keyboardLiftPx : 0 }] };
  const sliderRowRef = { current: null };
  const amountFieldRef = { current: null };
  const onSliderRowLayout = () => {};
  function useWalletKeyboardLift() {
    return { keyboardLiftStyle, sliderRowRef, amountFieldRef, onSliderRowLayout };
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
    '@/features/wallet/useWalletKeyboardLift': { useWalletKeyboardLift },
    '@/features/wallet/components/ReceivePanel': { ReceivePanel: () => null },
    '@/features/wallet/components/WalletNotConnectedPanel': { WalletNotConnectedPanel: () => null },
    '@/features/wallet/components/WalletModeSwitch': { WalletModeSwitch: ModeSwitchHost },
    '@/features/wallet/wallet-mode': { WALLET_ACTION_BODY_HEIGHT: 430 },
    '@/features/wallet/components/ChainRow': { ChainRow: () => null },
    '@/features/wallet/components/LegalLinks': { LegalLinks: () => null },
    '@/features/wallet/components/SendPanel': { SendPanel: () => null },
    '@/features/wallet/components/PortfolioSection': { PortfolioSection: () => null },
    '@/features/wallet/app-view/AppView': { AppView: () => null },
    // #771: the app-view shell never renders in this harness (nothing selects
    // an app); the reducer stays a pass-through so `wallet-change` syncs bail.
    '@/features/wallet/app-view.state': {
      initialWalletAppView: { walletId: null, selectedApp: null },
      walletAppViewReducer: (state: unknown) => state,
    },
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
    AnimatedView: Animated.View,
    ModeSwitchHost,
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
    solanaConnected: true,
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
  const animatedStyles = renderer.root.findAllByType(loaded.AnimatedView).flatMap((node) => {
    const found: Record<string, unknown>[] = [];
    const visit = (style: unknown) => {
      if (Array.isArray(style)) style.forEach(visit);
      else if (style && typeof style === 'object') found.push(style as Record<string, unknown>);
    };
    visit(node.props.style);
    return found;
  });
  const dragStyle = animatedStyles.find((style) => 'borderTopLeftRadius' in style);
  assert.ok(dragStyle);
  assert.equal('top' in dragStyle, false);
  assert.equal(Array.isArray(dragStyle.transform), true);
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

test('wallet mode shell: the switch renders above a fixed 430 action body in the default swap mode', async () => {
  const loaded = loadOverview();
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(loaded.Overview, overviewProps()));
  });

  const switchNode = renderer.root.findByType(loaded.ModeSwitchHost);
  assert.equal(switchNode.props.mode, 'swap');

  // views[0] is the wallet container, views[1] the gold upper block, views[2]
  // the action body frame: it must carry the fixed height in the default state.
  const body = renderer.root.findAllByType(loaded.View)[2].props.style;
  assert.equal(body.height, 430);

  // Re-selecting the only enabled mode must not move the frame or remount or
  // re-render the composer ("switching changes only the panel body; header,
  // panel height and slider position never move").
  const rendersBefore = loaded.actionRenders.length;
  await act(async () => {
    switchNode.props.onSelect('swap');
  });
  assert.equal(renderer.root.findAllByType(loaded.View)[2].props.style.height, 430);
  assert.equal(loaded.actionRenders.length, rendersBefore);
});

/** The lift wrapper's translateY, read from the rendered AnimatedView tree. */
function panelLift(loaded: ReturnType<typeof loadOverview>, renderer: ReactTestRenderer): number | undefined {
  const styles = renderer.root.findAllByType(loaded.AnimatedView).flatMap((node) => {
    const found: Record<string, unknown>[] = [];
    const visit = (style: unknown) => {
      if (Array.isArray(style)) style.forEach(visit);
      else if (style && typeof style === 'object') found.push(style as Record<string, unknown>);
    };
    visit(node.props.style);
    return found;
  });
  const liftStyle = styles.find(
    (style) => 'transform' in style && !('borderTopLeftRadius' in style),
  );
  return liftStyle ? (liftStyle.transform as { translateY: number }[])[0]?.translateY : undefined;
}

test('wallet keyboard lift: a keyboard overlapping the slider lifts the panel block by the overlap', async () => {
  const loaded = loadOverview({ keyboardLiftPx: 152 });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(loaded.Overview, overviewProps()));
  });
  assert.equal(panelLift(loaded, renderer), -152);
  // The lift is a transform only: the action frame keeps its size.
  assert.equal(renderer.root.findAllByType(loaded.View)[2].props.style.height, 430);
});

test('wallet keyboard lift: a keyboard with no overlap leaves the panel at rest', async () => {
  const loaded = loadOverview({ keyboardLiftPx: 0 });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(loaded.Overview, overviewProps()));
  });
  assert.equal(panelLift(loaded, renderer), 0);
});
