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

function host(name: string, imperative?: (props: RenderProps) => Record<string, unknown>) {
  const Component = React.forwardRef((props: RenderProps, ref: React.Ref<unknown>) => {
    React.useImperativeHandle(ref, () => (imperative?.(props) ?? {}));
    return React.createElement(name, props, props.children as React.ReactNode);
  });
  Component.displayName = name;
  return Component;
}

function loadSwitch() {
  const transpile = (file: string) => ts.transpileModule(
    readFileSync(new URL(file, import.meta.url), 'utf8'),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.React,
        esModuleInterop: true,
      },
    },
  ).outputText;

  // wallet-mode.ts is dependency-free: evaluate it so the switch is asserted
  // against the real constants instead of a mock.
  const modeModule: Record<string, unknown> = {};
  runInNewContext(transpile('./wallet-mode.ts'), { exports: modeModule }, { filename: 'wallet-mode.fixture.js' });

  const View = host('View');
  const Text = host('Text');
  // The tooltip measures from the pressed segment: hand every pressable the
  // same deterministic window geometry.
  const Pressable = host('Pressable', () => ({
    measureInWindow: (callback: (x: number, y: number, w: number, h: number) => void) => callback(9, 52, 88, 34),
  }));
  const Modal = host('Modal');
  const reactNativeMocks: Record<string, unknown> = {
    View,
    Text,
    Pressable,
    Modal,
    Dimensions: { get: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }) },
    StyleSheet: { create: (styles: unknown) => styles },
  };

  const exports: { WalletModeSwitch?: React.ComponentType<RenderProps> } = {};
  const sandboxRequire = (name: string) => {
    if (name === '@/features/wallet/wallet-mode') return modeModule;
    if (name === '@/features/swap/swap.theme') return { swapTheme: { gold: '#FFD166', navy: '#031F2C' } };
    if (name === 'react') return React;
    if (name === 'react-native') return reactNativeMocks;
    throw new Error(`unexpected require: ${name}`);
  };
  runInNewContext(
    transpile('./components/WalletModeSwitch.tsx'),
    { exports, React, require: sandboxRequire, setTimeout, clearTimeout },
    { filename: 'WalletModeSwitch.fixture.js' },
  );

  return {
    WalletModeSwitch: exports.WalletModeSwitch!,
    View,
    Text,
    Pressable,
    Modal,
    modes: modeModule as {
      WALLET_ACTION_BODY_HEIGHT: number;
      WALLET_ACTION_MODES: { id: string; label: string; enabled: boolean }[];
    },
  };
}

function propsWith(onSelect: (mode: string) => void, extra: RenderProps = {}): RenderProps {
  return { mode: 'swap', onSelect, ...extra };
}

async function renderSwitch(loaded: ReturnType<typeof loadSwitch>, extra: RenderProps = {}) {
  const selected: string[] = [];
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(
      loaded.WalletModeSwitch,
      propsWith((mode) => selected.push(mode), extra),
    ));
  });
  return { renderer, selected };
}

test('wallet mode shell: four modes in order, Swap and Receive enabled, fixed 430 body', () => {
  const loaded = loadSwitch();
  // The mode constants come from the fixture's vm realm: JSON round-trip so
  // deepStrictEqual compares same-realm objects.
  assert.deepEqual(
    JSON.parse(JSON.stringify(loaded.modes.WALLET_ACTION_MODES)),
    [
      { id: 'swap', label: 'Swap', enabled: true },
      { id: 'move', label: 'Move', enabled: false },
      { id: 'send', label: 'Send', enabled: false },
      { id: 'receive', label: 'Receive', enabled: true },
    ],
  );
  assert.equal(loaded.modes.WALLET_ACTION_BODY_HEIGHT, 430);
});

test('the switch renders the four labels in order with Swap selected on load', async () => {
  const loaded = loadSwitch();
  const { renderer, selected } = await renderSwitch(loaded);

  const labels = ['Swap', 'Move', 'Send', 'Receive'];
  const segments = renderer.root.findAll(
    (node) => node.type === loaded.Pressable
      && typeof node.props.accessibilityLabel === 'string'
      && labels.includes(node.props.accessibilityLabel),
  );
  assert.deepEqual(segments.map((segment) => segment.props.accessibilityLabel), labels);
  // accessibilityState objects come from the fixture's vm realm: compare the
  // selected flag itself, not the object identity.
  assert.deepEqual(
    segments.map((segment) => segment.props.accessibilityState.selected),
    [true, false, false, false],
  );
  assert.deepEqual(
    segments.map((segment) => segment.props.accessibilityHint),
    ['Switch to this mode', 'Coming soon', 'Coming soon', 'Switch to this mode'],
  );
  assert.deepEqual(selected, []);
});

test('tapping a disabled mode shows "Coming soon" and never switches', async () => {
  const loaded = loadSwitch();
  const { renderer, selected } = await renderSwitch(loaded);

  const move = renderer.root.find(
    (node) => node.type === loaded.Pressable && node.props.accessibilityLabel === 'Move',
  );
  await act(async () => {
    move.props.onPress();
  });

  const tooltip = renderer.root.find(
    (node) => node.type === loaded.Text && node.props.children === 'Coming soon',
  );
  assert.ok(tooltip);
  assert.deepEqual(selected, []);

  // Unmount before the real auto-dismiss timer fires outside act().
  await act(async () => {
    renderer.unmount();
  });
});

test('tapping Receive switches to receive; Move and Send stay Coming soon', async () => {
  const loaded = loadSwitch();
  const { renderer, selected } = await renderSwitch(loaded);

  const receive = renderer.root.find(
    (node) => node.type === loaded.Pressable && node.props.accessibilityLabel === 'Receive',
  );
  await act(async () => {
    receive.props.onPress();
  });
  assert.deepEqual(selected, ['receive']);

  for (const label of ['Move', 'Send']) {
    const segment = renderer.root.find(
      (node) => node.type === loaded.Pressable && node.props.accessibilityLabel === label,
    );
    await act(async () => {
      segment.props.onPress();
    });
  }
  assert.deepEqual(selected, ['receive']);
  // A "Coming soon" tooltip is showing for the last placeholder mode; unmount
  // before the real auto-dismiss timer fires outside act().
  assert.ok(renderer.root.find(
    (node) => node.type === loaded.Text && node.props.children === 'Coming soon',
  ));
  await act(async () => {
    renderer.unmount();
  });
});

test('tapping Swap selects swap; locked pressings do nothing', async () => {
  const loaded = loadSwitch();
  // A selected segment does not re-select itself, so drive the only enabled
  // path from a placeholder mode: Move is not switchable, Swap is.
  const { renderer, selected } = await renderSwitch(loaded, { mode: 'move' });

  const swap = renderer.root.find(
    (node) => node.type === loaded.Pressable && node.props.accessibilityLabel === 'Swap',
  );
  await act(async () => {
    swap.props.onPress();
  });
  assert.deepEqual(selected, ['swap']);

  const { renderer: lockedRenderer, selected: lockedSelected } = await renderSwitch(
    loaded,
    { locked: true },
  );
  for (const label of ['Move', 'Swap']) {
    const segment = lockedRenderer.root.find(
      (node) => node.type === loaded.Pressable && node.props.accessibilityLabel === label,
    );
    await act(async () => {
      segment.props.onPress();
    });
  }
  assert.deepEqual(lockedSelected, []);
  const tooltip = lockedRenderer.root.findAll(
    (node) => node.type === loaded.Text && node.props.children === 'Coming soon',
  );
  assert.deepEqual(tooltip, []);
});

test('the "Coming soon" tooltip auto-dismisses', async (t) => {
  // Mocked timers must install before loadSwitch() captures setTimeout for
  // the component sandbox.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const loaded = loadSwitch();
  const { renderer } = await renderSwitch(loaded);

  const move = renderer.root.find(
    (node) => node.type === loaded.Pressable && node.props.accessibilityLabel === 'Move',
  );
  await act(async () => {
    move.props.onPress();
  });
  assert.ok(renderer.root.find(
    (node) => node.type === loaded.Text && node.props.children === 'Coming soon',
  ));

  await act(async () => {
    t.mock.timers.tick(1800);
  });
  assert.deepEqual(
    renderer.root.findAll(
      (node) => node.type === loaded.Text && node.props.children === 'Coming soon',
    ),
    [],
  );
});
