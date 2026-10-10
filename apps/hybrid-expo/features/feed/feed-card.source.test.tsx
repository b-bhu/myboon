import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { URL } from 'node:url';
import test from 'node:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import ts from 'typescript';
import { FEED_COLORS } from './feed.constants';
import { reportSourceName } from './feed.api';
import type { FeedItem } from './feed.types';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const require = createRequire(import.meta.url);

function host(name: string) {
  const Component = React.forwardRef((props: { children?: React.ReactNode }, _ref: React.Ref<unknown>) => (
    React.createElement(name, props, props.children)
  ));
  Component.displayName = name;
  return Component;
}

function loadFeedCard() {
  const source = ts.transpileModule(
    readFileSync(new URL('./components/FeedCard.tsx', import.meta.url), 'utf8'),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.React,
        esModuleInterop: true,
      },
    },
  ).outputText;
  const exports: { FeedCard?: React.ComponentType<{ item: FeedItem, onPress: (item: FeedItem) => void }> } = {};
  const mocks: Record<string, unknown> = {
    react: React,
    'expo-image': { Image: host('Image') },
    'react-native': {
      Pressable: host('Pressable'),
      StyleSheet: { create: (styles: unknown) => styles },
      Text: host('Text'),
      View: host('View'),
      useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
    },
    '@/features/feed/feed.constants': { FEED_COLORS },
    '@/features/feed/feed.api': {
      reportSourceName,
      toRelativeTime: () => '3m ago',
    },
  };
  runInNewContext(source, {
    exports,
    React,
    require: (name: string) => (name in mocks ? mocks[name] : require(name)),
  }, { filename: 'FeedCard.fixture.js' });
  return exports.FeedCard!;
}

const FeedCard = loadFeedCard();

function item(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    id: 'report-1',
    category: 'feed',
    createdAt: '2026-10-06T12:00:00Z',
    headline: 'Bitcoin ETFs return to net inflows',
    description: 'Latest session recorded a net inflow.',
    actions: [],
    ...overrides,
  };
}

function textNodes(node: ReactTestRenderer): string[] {
  const found: string[] = [];
  const visit = (value: unknown) => {
    if (typeof value === 'string') {
      found.push(value);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const children = (value as { children?: unknown }).children;
    if (Array.isArray(children)) children.forEach(visit);
    else visit(children);
  };
  visit(node.toJSON());
  return found;
}

test('lead and list report cards show the outlet in the footer and keep Read', async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(FeedCard, { item: item({ isTop: true, sourceName: 'ETF flow desk' }), onPress: () => {} }));
  });
  const lead = textNodes(renderer);
  assert.ok(lead.includes('ETF flow desk'));
  assert.ok(lead.includes('Read more →'));
  assert.equal(lead.includes('Open update'), false);
  const root = renderer.root.findByType('Pressable' as never);
  assert.equal(root.props.accessibilityLabel, 'Bitcoin ETFs return to net inflows, ETF flow desk, 3m ago');
  const source = renderer.root.findAllByType('Text' as never).find((node) => node.props.children === 'ETF flow desk');
  assert.equal(source?.props.style.fontSize, 10);
  assert.equal(source?.props.style.color, FEED_COLORS.textFaint);
  assert.equal(source?.props.numberOfLines, 1);

  await act(async () => {
    renderer.update(React.createElement(FeedCard, { item: item({ sourceName: 'World desk' }), onPress: () => {} }));
  });
  assert.ok(textNodes(renderer).includes('World desk'));
  assert.equal(textNodes(renderer).includes('Read more →'), false);
  await act(async () => renderer.unmount());
});

test('a missing or blank report source leaves the card without an empty label', async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(FeedCard, { item: item({ isTop: true, sourceName: '   ' }), onPress: () => {} }));
  });
  const labels = textNodes(renderer);
  assert.equal(labels.includes(''), false);
  assert.equal(labels.includes('   '), false);
  assert.ok(labels.includes('Read more →'));
  assert.equal(renderer.root.findByType('Pressable' as never).props.accessibilityLabel, 'Bitcoin ETFs return to net inflows, 3m ago');

  await act(async () => {
    renderer.update(React.createElement(FeedCard, { item: item(), onPress: () => {} }));
  });
  assert.equal(textNodes(renderer).some((label) => label.trim() === ''), false);
  assert.equal(renderer.root.findAllByType('Text' as never).some((node) => node.props.style?.fontSize === 10), false);
  await act(async () => renderer.unmount());
});
