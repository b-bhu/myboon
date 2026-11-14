import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import ts from 'typescript';
import { sectionFailureTitle } from './feed-mosaic';
import { FEED_TOKENS } from './feed-tokens';
import { latestUpdateTime, presentLatestUpdates, type LatestUpdatesPresentation } from './latest-updates';
import type { LatestUpdate } from '@myboon/shared/latest-updates';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const require = createRequire(import.meta.url);
const opened: string[] = [];

function host(name: string) {
  const Component = React.forwardRef((props: { children?: React.ReactNode }, _ref: React.Ref<unknown>) => (
    React.createElement(name, props, props.children)
  ));
  Component.displayName = name;
  return Component;
}

function loadSegment() {
  const source = ts.transpileModule(
    readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'components/LatestUpdateSegment.tsx'), 'utf8'),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.React,
        esModuleInterop: true,
      },
    },
  ).outputText;
  const exports: { LatestUpdateSegment?: React.ComponentType<{
    presentation: LatestUpdatesPresentation;
    onRetry: () => void;
    now?: Date;
  }> } = {};
  const mocks: Record<string, unknown> = {
    react: React,
    'react-native': {
      Linking: { openURL: (url: string) => { opened.push(url); return Promise.resolve(); } },
      Pressable: host('Pressable'),
      StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
      Text: host('Text'),
      View: host('View'),
    },
    '../feed-design': { FEED_TOKENS, monoFontFamily: () => 'monospace' },
    '../feed-mosaic': { sectionFailureTitle },
    '../latest-updates': { latestUpdateTime },
    './ui/FeedBox': {
      FeedBox: ({ children, accessibilityLabel }: { children?: React.ReactNode; accessibilityLabel?: string }) => (
        React.createElement('View', { accessibilityLabel }, children)
      ),
    },
    './ui/SampleDataLabel': {
      SampleDataLabel: ({ enabled }: { enabled?: boolean }) => (
        enabled ? React.createElement('Text', null, 'SAMPLE DATA') : null
      ),
    },
  };
  runInNewContext(source, {
    exports,
    React,
    require: (name: string) => {
      if (name in mocks) return mocks[name];
      return require(name);
    },
  }, { filename: 'LatestUpdateSegment.fixture.js' });
  return exports.LatestUpdateSegment!;
}

const LatestUpdateSegment = loadSegment();

function update(id: string, publishedAt: string, headline: string, sources: LatestUpdate['sources']): LatestUpdate {
  return {
    id,
    entitySlug: id,
    entityName: id === 'newer' ? 'Bitcoin' : 'Federal Reserve',
    entityType: 'asset',
    headline,
    whatHappened: `${headline} happened`,
    howWeGotHere: `${headline} background`,
    whatToWatch: `${headline} next`,
    sources,
    publishedAt,
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

const now = new Date('2026-11-14T18:00:00.000Z');
const older = update('older', '2026-11-13T19:00:00.000Z', 'Fed minutes leave a cut on the table', [{
  itemId: 'fed-source',
  title: 'FOMC minutes (sample)',
  link: 'https://example.com/fomc-minutes',
  occurredAt: '2026-11-13T18:00:00.000Z',
}]);
const newer = update('newer', '2026-11-14T16:00:00.000Z', 'Bitcoin holds above $100,000', [
  {
    itemId: 'btc-flows',
    title: 'ETF flow desk (sample)',
    link: 'https://example.com/bitcoin-etf-flows',
    occurredAt: '2026-11-14T14:00:00.000Z',
  },
  {
    itemId: 'btc-price',
    title: 'Price recap (sample)',
    link: 'https://example.com/bitcoin-price',
    occurredAt: '2026-11-14T15:00:00.000Z',
  },
]);

test('an empty latest-update list hides the segment', async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(LatestUpdateSegment, {
      presentation: presentLatestUpdates([], null, false),
      onRetry: () => {},
      now,
    }));
  });
  assert.equal(renderer.toJSON(), null);
  await act(async () => renderer.unmount());
});

test('a failed latest-update request shows retry and the press refetches', async () => {
  let retried = 0;
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(LatestUpdateSegment, {
      presentation: presentLatestUpdates(null, 'Latest updates request failed (503)', false),
      onRetry: () => { retried += 1; },
      now,
    }));
  });
  const labels = textNodes(renderer);
  assert.ok(labels.includes('Latest updates unavailable'));
  assert.ok(labels.includes('Latest updates could not be loaded.'));
  assert.ok(labels.includes('Retry'));
  const retry = renderer.root.findByProps({ accessibilityLabel: 'Retry Latest updates unavailable' });
  await act(async () => { retry.props.onPress(); });
  assert.equal(retried, 1);
  await act(async () => renderer.unmount());
});

test('populated latest updates show the headline, three sections and sources, newest first', async () => {
  opened.length = 0;
  const presentation = presentLatestUpdates([older, newer], null, false);
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(LatestUpdateSegment, {
      presentation,
      onRetry: () => {},
      now,
    }));
  });
  const labels = textNodes(renderer);
  const newerAt = labels.indexOf('Bitcoin holds above $100,000');
  const olderAt = labels.indexOf('Fed minutes leave a cut on the table');
  assert.ok(newerAt !== -1 && olderAt !== -1 && newerAt < olderAt);
  for (const label of ['What happened', 'How we got here', 'What to watch', 'Sources']) {
    assert.ok(labels.includes(label), label);
  }
  assert.ok(labels.includes('Bitcoin holds above $100,000 happened'));
  assert.ok(labels.includes('Bitcoin holds above $100,000 background'));
  assert.ok(labels.includes('Bitcoin holds above $100,000 next'));
  assert.ok(labels.includes('ETF flow desk (sample)'));
  assert.ok(labels.includes('Price recap (sample)'));
  assert.ok(labels.includes('FOMC minutes (sample)'));
  assert.ok(labels.includes(latestUpdateTime(newer.publishedAt, now)));

  const headline = renderer.root.findAllByType('Text' as never).find((node) => node.props.children === 'Bitcoin holds above $100,000');
  assert.equal(headline?.props.style.fontSize, FEED_TOKENS.type.section);
  assert.equal(headline?.props.style.fontWeight, '700');
  const sectionLabel = renderer.root.findAllByType('Text' as never).find((node) => node.props.children === 'What happened');
  assert.equal(sectionLabel?.props.style.fontSize, FEED_TOKENS.type.label);
  assert.equal(sectionLabel?.props.style.color, FEED_TOKENS.colors.textFaint);

  const source = renderer.root.findByProps({ accessibilityLabel: 'Price recap (sample)' });
  await act(async () => { source.props.onPress(); });
  assert.deepEqual(opened, ['https://example.com/bitcoin-price']);
  await act(async () => renderer.unmount());
});

test('a loading latest-update segment shows the skeleton and not a headline', async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(LatestUpdateSegment, {
      presentation: { status: 'loading', updates: [], message: null, sample: false },
      onRetry: () => {},
      now,
    }));
  });
  assert.equal(textNodes(renderer).includes('Bitcoin holds above $100,000'), false);
  assert.ok(renderer.root.findByProps({ accessibilityLabel: 'Loading latest updates' }));
  await act(async () => renderer.unmount());
});
