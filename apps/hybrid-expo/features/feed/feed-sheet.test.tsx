import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import ts from 'typescript';
import { FEED_TOKENS } from './feed-tokens';
import { newsSheetHeight, sheetBodyDragClaims, shouldDismissSheet, updateTimeAgo } from './feed-updates';
import type { NarrativeSheetItem } from './components/NarrativeSheet';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function host(name: string) {
  return React.forwardRef(function Host(
    props: { children?: React.ReactNode; [key: string]: unknown },
    _ref: React.Ref<unknown>,
  ) {
    return React.createElement(name, props, props.children);
  });
}

class MockAnimatedValue {
  private current: number;
  constructor(initial = 0) {
    this.current = typeof initial === 'number' ? initial : 0;
  }
  setValue(next: number) {
    this.current = next;
    return this;
  }
  getValue() {
    return this.current;
  }
}

type PanConfig = {
  onMoveShouldSetPanResponder: (event: unknown, gesture: Gesture) => boolean;
  onPanResponderRelease: (event: unknown, gesture: Gesture) => void;
};

type Gesture = { dy: number; dx: number; vy: number };

function loadNarrativeSheet() {
  // One capture per PanResponder.create call in mount order: [grabber, article].
  const responders: PanConfig[] = [];
  const animation = (value: { setValue?: (next: number) => void }, config: { toValue?: number }) => ({
    start: (callback?: (result: { finished: boolean }) => void) => {
      if (value && typeof config?.toValue === 'number') value.setValue?.(config.toValue);
      callback?.({ finished: true });
    },
  });
  const mocks: Record<string, unknown> = {
    react: React,
    'react-native': {
      View: host('View'),
      Text: host('Text'),
      Pressable: host('Pressable'),
      Modal: host('Modal'),
      ScrollView: host('ScrollView'),
      StyleSheet: {
        create: (styles: unknown) => styles,
        absoluteFillObject: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
      },
      Animated: {
        Value: MockAnimatedValue,
        View: host('Animated.View'),
        add: () => new MockAnimatedValue(0),
        timing: animation,
        spring: animation,
      },
      PanResponder: {
        create: (config: PanConfig) => {
          responders.push(config);
          return { panHandlers: config };
        },
      },
      useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
    },
    'expo-image': { Image: host('Image') },
    '../use-reduced-motion': { useReducedMotion: () => false },
    '@/features/feed/components/TakeActionApps': { TakeActionApps: host('TakeActionApps') },
    '@/features/feed/feed-design': {
      FEED_TOKENS,
      monoFontFamily: () => 'Menlo',
    },
    // The real pure helpers stay the sheet's single source of truth.
    '@/features/feed/feed-updates': {
      newsSheetHeight,
      shouldDismissSheet,
      sheetBodyDragClaims,
      updateTimeAgo,
    },
  };
  const source = ts.transpileModule(
    readFileSync(fileURLToPath(new URL('./components/NarrativeSheet.tsx', import.meta.url).href), 'utf8'),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.React,
        esModuleInterop: true,
      },
    },
  ).outputText;
  const exports: { NarrativeSheet?: React.ComponentType<{ item: NarrativeSheetItem | null; onClose: () => void }> } = {};
  runInNewContext(
    source,
    {
      exports,
      React,
      require: (name: string) => {
        if (!(name in mocks)) throw new Error(`feed-sheet test: unmocked require ${name}`);
        return mocks[name];
      },
    },
    { filename: 'NarrativeSheet.fixture.js' },
  );
  const NarrativeSheet = exports.NarrativeSheet;
  assert.ok(NarrativeSheet, 'NarrativeSheet exported the component');
  return { NarrativeSheet: NarrativeSheet!, responders };
}

// Two hours before mount: the mock meta's right half reads '2h ago · MyBoon'.
// The two-hour window absorbs the minutes a test run costs.
const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();

const item = (overrides: Partial<NarrativeSheetItem> = {}): NarrativeSheetItem => ({
  id: 'update-1',
  title: 'Rate-cut bets jump after a softer inflation print',
  summary: 'Traders now price two cuts by March.',
  createdAt: twoHoursAgo,
  imageUrl: 'https://example.com/lead.png',
  imageKind: 'content',
  imageAttribution: null,
  topic: 'Bitcoin',
  category: 'Macro',
  sourceName: 'MyBoon',
  keyPoints: ['Core CPI 0.2% vs 0.3% expected', 'March cut odds 41% → 68%'],
  howWeGotHere: 'The softer core reading was the first downside surprise in four months.',
  whatToWatch: 'Futures moved quickly to price a second cut, and risk assets followed.',
  ...overrides,
});

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

function flatStyle(style: unknown): Record<string, unknown> {
  if (typeof style === 'function') return flatStyle((style as (state: unknown) => unknown)({ pressed: false }));
  if (Array.isArray(style)) {
    return style.reduce((merged, entry) => Object.assign(merged, flatStyle(entry)), {});
  }
  return style && typeof style === 'object' ? { ...(style as Record<string, unknown>) } : {};
}

test('the sheet paints the mock layout: meta halves, 28/33 title, 150 hero, lead, Key points, The full picture', async () => {
  const { NarrativeSheet } = loadNarrativeSheet();
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(NarrativeSheet, { item: item({}), onClose: () => {} }));
  });
  const texts = textNodes(renderer);
  // The mock's two meta halves (docs/design/feed.html #s-todaysheet, #798).
  assert.ok(texts.includes('Bitcoin · Macro'), 'meta shows topic · category');
  assert.ok(texts.includes('2h ago · MyBoon'), 'meta shows time · source');
  assert.equal(texts.includes('2H · LATEST'), false, 'the old single faint meta is gone');
  // The three all-caps blocks and the Sources list are gone from the sheet.
  assert.equal(texts.includes('What happened'), false);
  assert.equal(texts.includes('How we got here'), false);
  assert.equal(texts.includes('What to watch'), false);
  assert.equal(texts.includes('Sources'), false);
  // Lead paragraph, boxed Key points, then The full picture.
  assert.ok(texts.includes('Traders now price two cuts by March.'), 'lead paragraph rendered');
  assert.ok(texts.includes('Key points'), 'Key points label rendered');
  assert.ok(texts.includes('Core CPI 0.2% vs 0.3% expected'), 'first key point rendered');
  assert.ok(texts.includes('March cut odds 41% → 68%'), 'second key point rendered');
  assert.ok(texts.includes('The full picture'), 'full picture label rendered');
  assert.ok(texts.includes('The softer core reading was the first downside surprise in four months.'));
  assert.ok(texts.includes('Futures moved quickly to price a second cut, and risk assets followed.'));

  const title = renderer.root.findAllByType('Text' as never).find((node) => node.props.children === 'Rate-cut bets jump after a softer inflation print');
  assert.ok(title, 'title rendered');
  const titleStyle = flatStyle(title?.props.style);
  assert.equal(titleStyle.fontSize, FEED_TOKENS.type.title, 'title is 28');
  assert.equal(titleStyle.lineHeight, 33, 'title line height is 33');
  assert.equal(titleStyle.fontWeight, '700', 'title weight is 700');

  const hero = renderer.root.findByType('Image' as never);
  assert.equal(flatStyle(hero.props.style).height, 150, 'hero is 150 tall');
  assert.equal(flatStyle(hero.props.style).borderColor, FEED_TOKENS.colors.border, 'hero carries the hairline');

  const lead = renderer.root.findAllByType('Text' as never).find((node) => node.props.children === 'Traders now price two cuts by March.');
  const leadStyle = flatStyle(lead?.props.style);
  assert.equal(leadStyle.fontSize, 17, 'lead is 17');
  assert.equal(leadStyle.lineHeight, 25, 'lead line height is 25');
  assert.equal(leadStyle.color, FEED_TOKENS.colors.text, 'lead is bone');

  const grabberArea = renderer.root.findAllByType('View' as never).find((node) => flatStyle(node.props.style).height === 24);
  assert.ok(grabberArea, 'grabber area rendered');
  const grabber = renderer.root.findAllByType('View' as never).find((node) => flatStyle(node.props.style).width === 36);
  assert.ok(grabber, 'grabber rendered');
  const grabberStyle = flatStyle(grabber?.props.style);
  assert.equal(grabberStyle.height, 4, 'grabber is 36x4');
  assert.equal(grabberStyle.backgroundColor, FEED_TOKENS.colors.border, 'grabber paints #185A70');

  // The Key points box: hairline border, 8 radius, 12 padding, separator rows.
  const keyBox = renderer.root.findAllByType('View' as never).find((node) => {
    const style = flatStyle(node.props.style);
    return style.borderWidth === 1 && style.borderColor === FEED_TOKENS.colors.border && style.borderRadius === 8;
  });
  assert.ok(keyBox, 'Key points box rendered');
  const rows = renderer.root.findAllByType('View' as never).filter((node) => flatStyle(node.props.style).paddingVertical === 6);
  assert.equal(rows.length, 2, 'key point rows carry the 6 padding');
  const separators = rows.filter((node) => flatStyle(node.props.style).borderTopWidth === 1);
  assert.equal(separators.length, 1, 'only the second key point row gets the hairline');
  await act(async () => renderer.unmount());
});

test('a downward drag on the sheet body or grabber dismisses; upward and sideways never claim', async () => {
  const { NarrativeSheet, responders } = loadNarrativeSheet();
  let closeCount = 0;
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(NarrativeSheet, { item: item({}), onClose: () => { closeCount += 1; } }));
  });
  assert.equal(responders.length, 2, 'grabber and article responders captured');
  const [grabber, article] = responders;

  // The article's claim is gated on scroll top; past the top it never claims.
  assert.equal(grabber.onMoveShouldSetPanResponder(null, { dy: 40, dx: 0, vy: 0 }), true, 'grabber claims a downward drag');
  assert.equal(article.onMoveShouldSetPanResponder(null, { dy: 40, dx: 0, vy: 0 }), true, 'article claims at scroll top');
  const scroll = renderer.root.findByType('ScrollView' as never);
  await act(async () => {
    (scroll.props.onScroll as (event: unknown) => void)({ nativeEvent: { contentOffset: { x: 0, y: 24 } } });
  });
  assert.equal(article.onMoveShouldSetPanResponder(null, { dy: 40, dx: 0, vy: 0 }), false, 'a scrolled article keeps its scroll');
  assert.equal(grabber.onMoveShouldSetPanResponder(null, { dy: 40, dx: 0, vy: 0 }), true, 'the grabber still claims');
  await act(async () => {
    (scroll.props.onScroll as (event: unknown) => void)({ nativeEvent: { contentOffset: { x: 0, y: 0 } } });
  });
  assert.equal(article.onMoveShouldSetPanResponder(null, { dy: 40, dx: 0, vy: 0 }), true, 'back at the top the body claims again');
  // Upward drags (scrolling) and sideways drags (paging) are never claimed.
  assert.equal(article.onMoveShouldSetPanResponder(null, { dy: -30, dx: 0, vy: 0 }), false);
  assert.equal(article.onMoveShouldSetPanResponder(null, { dy: 10, dx: 40, vy: 0 }), false);
  assert.equal(grabber.onMoveShouldSetPanResponder(null, { dy: 10, dx: 40, vy: 0 }), false);

  // A downward drag past the quarter-height threshold on the body dismisses.
  assert.equal(shouldDismissSheet(200, 0, newsSheetHeight(844)), true, 'the 90% sheet dismisses past a quarter');
  await act(async () => {
    article.onPanResponderRelease(null, { dy: 200, dx: 0, vy: 0 });
  });
  assert.equal(closeCount, 1, 'the body drag closed the sheet');
  await act(async () => {
    grabber.onPanResponderRelease(null, { dy: 200, dx: 0, vy: 0 });
  });
  assert.equal(closeCount, 2, 'the grabber drag closed the sheet');
  // A short slow drag springs back instead of closing.
  await act(async () => {
    grabber.onPanResponderRelease(null, { dy: 30, dx: 0, vy: 0 });
  });
  assert.equal(closeCount, 2, 'a short drag stays open');
  // The backdrop tap still closes the sheet.
  const backdrop = renderer.root.findAllByType('Pressable' as never).find((node) => node.props.accessibilityLabel === 'Close news');
  assert.ok(backdrop, 'backdrop rendered');
  await act(async () => {
    (backdrop?.props.onPress as () => void)();
  });
  assert.equal(closeCount, 3, 'backdrop tap closed the sheet');
  await act(async () => renderer.unmount());
});

test('sheet halves the data lacks stay out: no beat category, no source, no Key points, no full picture', async () => {
  const { NarrativeSheet } = loadNarrativeSheet();
  const bare = item({
    topic: 'Bitcoin',
    category: null,
    sourceName: null,
    keyPoints: undefined,
    howWeGotHere: '',
    whatToWatch: '',
  } as Partial<NarrativeSheetItem>);
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(NarrativeSheet, { item: bare, onClose: () => {} }));
  });
  const texts = textNodes(renderer);
  assert.ok(texts.includes('Bitcoin'), 'topic half rendered alone');
  assert.equal(texts.includes('undefined'), false, 'no undefined text leaks');
  assert.equal(texts.includes('Key points'), false, 'Key points stays out without data');
  assert.equal(texts.includes('The full picture'), false, 'The full picture stays out without data');
  assert.ok(texts.includes('2h ago'), 'the age half survives alone');
  await act(async () => renderer.unmount());
});
