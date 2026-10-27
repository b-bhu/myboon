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

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const require = createRequire(import.meta.url);
const testDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(testDir, '../..');

type StyleValue = Record<string, unknown>;
type PropsTable = Record<string, unknown>;

type FeedTokensType = {
  colors: Record<string, string>;
  type: Record<string, number>;
  space: Record<string, number>;
  radius: Record<string, number>;
};

type FeedMocksType = {
  isFeedMocksEnabled: (value: string | undefined) => boolean;
  FEED_MOCKS: boolean;
  STORY_ACTIVE_DAYS: number;
  isStoryActive: (updatedAt: string, now?: Date) => boolean;
  withMock: <T>(value: T, enabled?: boolean) => T | null;
};

type FeedFixturesType = {
  FEED_FIXTURES: {
    storyCatchUp: string[];
    storyKeyNumbers: { label: string; value: unknown }[];
    eventLastTime: { asset: string; move: number }[];
    walletStats: { address: string; pnl7d: number; winRate: number; rank: number }[];
    tokenSparklines: Record<string, number[]>;
  };
};

const TOKEN_COLORS: Record<string, string> = {
  screen: '#031F2C',
  card: '#073B4C',
  ground: '#063343',
  lift: '#0A4A60',
  border: '#185A70',
  text: '#F5FAFC',
  textDim: '#9CB8C2',
  textFaint: '#6B95A1',
  accent: '#FFD166',
  up: '#06D6A0',
  down: '#EF476F',
  backdrop: '#021821',
};

function flatStyle(style: unknown): StyleValue {
  if (typeof style === 'function') {
    return flatStyle((style as (state: unknown) => unknown)({ pressed: false }));
  }
  if (Array.isArray(style)) {
    return style.reduce<StyleValue>((merged, entry) => Object.assign(merged, flatStyle(entry)), {});
  }
  if (style && typeof style === 'object') return { ...(style as StyleValue) };
  return {};
}

function styleOfNode(node: unknown): StyleValue {
  const props = (node as { props?: { style?: unknown } }).props;
  return flatStyle(props?.style);
}

function textFromJson(node: unknown): string[] {
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
  visit(node);
  return found;
}

function textNodes(renderer: ReactTestRenderer): string[] {
  return textFromJson(renderer.toJSON());
}

function host(name: string) {
  return React.forwardRef(function Host(
    props: { children?: React.ReactNode; [key: string]: unknown },
    _ref: React.Ref<unknown>,
  ) {
    return React.createElement(name, props, props.children);
  });
}

function jsxRuntimeMock() {
  const render = (type: unknown, props: PropsTable | null, key?: unknown) => {
    const withKey: PropsTable = { ...(props ?? {}) };
    if (key !== undefined) withKey.key = key;
    return React.createElement(type as never, withKey as never);
  };
  return { Fragment: React.Fragment, jsx: render, jsxs: render, jsxDEV: render };
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

  interpolate() {
    return this;
  }

  addListener() {
    return { remove: () => undefined };
  }

  removeListeners() {
    /* noop */
  }

  stopAnimation(callback?: (result: { finished: boolean }) => void) {
    callback?.({ finished: true });
  }

  flattenOffset() {
    return this;
  }

  extractOffset() {
    return this;
  }
}

function makeReactNativeMocks() {
  const animation = (
    value?: { setValue?: (next: number) => void },
    config?: { toValue?: number },
  ) => ({
    start: (callback?: (result: { finished: boolean }) => void) => {
      if (value && config && typeof config.toValue === 'number') value.setValue?.(config.toValue);
      callback?.({ finished: true });
    },
  });
  return {
    View: host('View'),
    Text: host('Text'),
    Pressable: host('Pressable'),
    Modal: host('Modal'),
    ScrollView: host('ScrollView'),
    StyleSheet: {
      create: (styles: Record<string, unknown>) => styles,
      compose: (...styles: unknown[]) => styles.filter((entry) => entry),
      flatten: (style: unknown) => flatStyle(style),
      hairlineWidth: 1,
    },
    PanResponder: {
      create: (_config: unknown) => ({ panHandlers: {} }),
    },
    Animated: {
      Value: MockAnimatedValue,
      View: host('View'),
      Image: host('Image'),
      createAnimatedComponent: (Component: unknown) => Component,
      timing: animation,
      spring: animation,
    },
    Platform: {
      OS: 'ios',
      select: (options: Record<string, unknown>) => options.ios ?? options.default,
    },
    Dimensions: { get: (_name?: string) => ({ width: 390, height: 844, scale: 1, fontScale: 1 }) },
    useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
  };
}

const SIBLING_PATHS: Record<string, string> = {
  'feed-design': './feed-design.ts',
  'feed-mocks': './feed-mocks.ts',
  'feed-fixtures': './feed-fixtures.ts',
  FeedBox: './components/ui/FeedBox.tsx',
  SectionHeader: './components/ui/SectionHeader.tsx',
  SegmentedTabs: './components/ui/SegmentedTabs.tsx',
  FeedSheet: './components/ui/FeedSheet.tsx',
  SampleDataLabel: './components/ui/SampleDataLabel.tsx',
};

type LoadOptions = { feedMocksEnv?: string | undefined };

function loadFeedModule(relativePath: string, options: LoadOptions = {}): Record<string, unknown> {
  const filePath = fileURLToPath(new URL(relativePath, import.meta.url));
  const transpiled = ts.transpileModule(readFileSync(filePath, 'utf8'), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.React,
      esModuleInterop: true,
    },
  }).outputText;
  const moduleDir = path.dirname(filePath);
  const loadingBasename = path.basename(filePath).replace(/\.tsx?$/, '');
  const exportsTable: Record<string, unknown> = {};
  const siblings: Record<string, unknown> = {};

  const sandboxEnv: Record<string, string | undefined> = { ...process.env };
  if (options.feedMocksEnv === undefined) {
    delete sandboxEnv.EXPO_PUBLIC_FEED_MOCKS;
  } else {
    sandboxEnv.EXPO_PUBLIC_FEED_MOCKS = options.feedMocksEnv;
  }

  const mockMap: Record<string, unknown> = {
    react: React,
    react_jsx_runtime: jsxRuntimeMock(),
    react_jsx_dev_runtime: jsxRuntimeMock(),
    'react-native': makeReactNativeMocks(),
  };

  const sandboxRequire = (specifier: string) => {
    if (specifier === 'react/jsx-runtime') return mockMap.react_jsx_runtime;
    if (specifier === 'react/jsx-dev-runtime') return mockMap.react_jsx_dev_runtime;
    if (specifier in mockMap) return mockMap[specifier];
    const base = specifier.slice(specifier.lastIndexOf('/') + 1).replace(/\.tsx?$/, '');
    if (base in SIBLING_PATHS && base !== loadingBasename) {
      if (!(base in siblings)) siblings[base] = loadFeedModule(SIBLING_PATHS[base], options);
      return siblings[base];
    }
    return require(
      specifier.startsWith('@/') ? path.join(appRoot, specifier.slice(2))
      : specifier.startsWith('.') ? path.resolve(moduleDir, specifier)
      : specifier,
    );
  };

  runInNewContext(
    transpiled,
    {
      exports: exportsTable,
      React,
      require: sandboxRequire,
      console,
      process: { env: sandboxEnv, platform: process.platform, version: process.version },
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    },
    { filename: path.relative(appRoot, filePath) },
  );
  return exportsTable;
}

function loadFeedDesign() {
  return loadFeedModule('./feed-design.ts') as unknown as { FEED_TOKENS: FeedTokensType };
}

function loadFeedMocksModule(options: LoadOptions = {}) {
  return loadFeedModule('./feed-mocks.ts', options) as unknown as FeedMocksType;
}

function loadFeedFixtures() {
  return loadFeedModule('./feed-fixtures.ts') as unknown as FeedFixturesType;
}

function loadFeedComponent(relativePath: string, options: LoadOptions = {}) {
  return loadFeedModule(relativePath, options);
}

function componentOf(uiExports: Record<string, unknown>, name: string) {
  const value = uiExports[name];
  assert.equal(typeof value, 'function', `${name} must be an exported React component`);
  return value as unknown as React.ComponentType<PropsTable>;
}

async function mount(
  component: React.ComponentType<PropsTable>,
  props: PropsTable = {},
  ...children: React.ReactNode[]
) {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(component, props, ...children));
  });
  return renderer;
}

async function pressNode(node: unknown, label: string) {
  const props = (node as { props?: PropsTable }).props;
  assert.ok(props, `${label} node has props`);
  assert.equal(typeof props.onPress, 'function', `${label} exposes an onPress handler`);
  await act(async () => {
    (props.onPress as () => void)();
  });
}

const TYPE_KEYS = ['big', 'title', 'section', 'cardTitle', 'body', 'secondary', 'caption', 'label'];
const TYPE_SIZES = new Set([34, 28, 20, 18, 15, 14, 12, 11]);
const SPACE_KEYS = ['xs', 'sm', 'md', 'lg', 'xl', 'xxl'];
const SPACE_VALUES = new Set([4, 8, 12, 16, 24, 32]);

test('feed-design exports FEED_TOKENS with the prototype palette, type scale, spacing and radii', () => {
  const design = loadFeedDesign();
  const tokens = design.FEED_TOKENS;
  assert.ok(tokens && typeof tokens === 'object', 'FEED_TOKENS exported');
  assert.deepEqual(tokens.colors, TOKEN_COLORS);

  for (const key of TYPE_KEYS) {
    assert.ok(key in tokens.type, `type.${key} exists`);
  }
  for (const [key, size] of Object.entries(tokens.type)) {
    assert.ok(TYPE_SIZES.has(size), `type.${key}: ${size} is in the prototype type scale`);
  }

  for (const key of SPACE_KEYS) {
    assert.ok(key in tokens.space, `space.${key} exists`);
  }
  for (const [key, value] of Object.entries(tokens.space)) {
    assert.ok(SPACE_VALUES.has(value), `space.${key}: ${value} is an expected spacing step`);
  }

  assert.deepEqual(
    Object.keys(tokens.radius).filter((key) => ['chip', 'button', 'card', 'sheet'].includes(key)).sort(),
    ['button', 'card', 'chip', 'sheet'],
  );
  assert.deepEqual(tokens.radius, { chip: 4, button: 6, card: 8, sheet: 12 });
});

test('feed-mocks: isFeedMocksEnabled accepts only 1/true/on and exposes the module flag from the env', () => {
  const unset = loadFeedMocksModule();
  assert.equal(unset.FEED_MOCKS, false);
  assert.equal(unset.isFeedMocksEnabled(undefined), false);
  assert.equal(unset.isFeedMocksEnabled(''), false);
  assert.equal(unset.isFeedMocksEnabled('0'), false);
  assert.equal(unset.isFeedMocksEnabled('false'), false);
  assert.equal(unset.isFeedMocksEnabled('2'), false);
  assert.equal(unset.isFeedMocksEnabled('yes'), false);
  assert.equal(unset.isFeedMocksEnabled('Off'), false);

  assert.equal(unset.isFeedMocksEnabled('1'), true);
  assert.equal(unset.isFeedMocksEnabled(' true '), true);
  assert.equal(unset.isFeedMocksEnabled('ON'), true);
  assert.equal(unset.isFeedMocksEnabled('On'), true);

  const enabled = loadFeedMocksModule({ feedMocksEnv: '1' });
  assert.equal(enabled.FEED_MOCKS, true);
});

test('feed-mocks: story activity keeps the 7 day window fresh and rejects invalid dates', () => {
  const mocks = loadFeedMocksModule();
  assert.equal(mocks.STORY_ACTIVE_DAYS, 7);
  const updatedAt = '2026-10-01T00:00:00Z';
  assert.equal(mocks.isStoryActive(updatedAt, new Date('2026-10-07T23:59:59Z')), true, 'under 7 days is fresh');
  assert.equal(mocks.isStoryActive(updatedAt, new Date('2026-10-08T00:00:00Z')), false, 'exactly 7 days is stale');
  assert.equal(mocks.isStoryActive('not-a-date', new Date('2026-10-05T00:00:00Z')), false, 'invalid date is stale');
  assert.equal(mocks.isStoryActive('2100-01-01T00:00:00Z'), true, 'defaults now to the current time');
});

test('feed-mocks: withMock keeps values only when mocks are enabled', () => {
  const disabled = loadFeedMocksModule();
  assert.equal(disabled.withMock('gone'), null);
  assert.equal(disabled.withMock('kept', true), 'kept');

  const enabled = loadFeedMocksModule({ feedMocksEnv: 'true' });
  assert.equal(enabled.withMock('kept'), 'kept');
  assert.equal(enabled.withMock('gone', false), null);
  assert.equal(enabled.withMock(0), 0);
  assert.equal(enabled.withMock(true), true);
});

const assertFixtureShapes = (fixtures: FeedFixturesType) => {
  const FEED_FIXTURES = fixtures.FEED_FIXTURES;
  assert.ok(FEED_FIXTURES && typeof FEED_FIXTURES === 'object', 'FEED_FIXTURES exported');
  assert.ok(Array.isArray(FEED_FIXTURES.storyCatchUp), 'storyCatchUp is an array');
  assert.ok(FEED_FIXTURES.storyCatchUp.length >= 3, 'storyCatchUp has at least 3 points');
  assert.ok(
    FEED_FIXTURES.storyCatchUp.every((point) => typeof point === 'string' && point.trim().length > 0),
    'storyCatchUp points are non-empty strings',
  );

  assert.ok(Array.isArray(FEED_FIXTURES.storyKeyNumbers), 'storyKeyNumbers is an array');
  assert.equal(FEED_FIXTURES.storyKeyNumbers.length, 3);
  assert.ok(
    FEED_FIXTURES.storyKeyNumbers.every((row) =>
      typeof row.label === 'string' && row.label.trim().length > 0
      && (typeof row.value === 'number' || typeof row.value === 'string'),
    ),
    'storyKeyNumbers rows carry a label and a value',
  );

  assert.ok(Array.isArray(FEED_FIXTURES.eventLastTime), 'eventLastTime is an array');
  assert.ok(FEED_FIXTURES.eventLastTime.length >= 1, 'eventLastTime has rows');
  assert.ok(
    FEED_FIXTURES.eventLastTime.every((row) => typeof row.asset === 'string' && typeof row.move === 'number'),
    'eventLastTime rows carry an asset and a numeric move',
  );

  assert.ok(Array.isArray(FEED_FIXTURES.walletStats), 'walletStats is an array');
  assert.ok(FEED_FIXTURES.walletStats.length >= 1, 'walletStats has rows');
  assert.ok(
    FEED_FIXTURES.walletStats.every((row) =>
      typeof row.address === 'string' && row.address.trim().length > 0
      && typeof row.pnl7d === 'number'
      && typeof row.winRate === 'number' && row.winRate >= 0 && row.winRate <= 1
      && typeof row.rank === 'number',
    ),
    'walletStats rows carry address, pnl7d, winRate in [0,1] and rank',
  );

  const sparklines = FEED_FIXTURES.tokenSparklines;
  assert.ok(sparklines && typeof sparklines === 'object', 'tokenSparklines is a record');
  const sparklineEntries = Object.entries(sparklines);
  assert.ok(sparklineEntries.length >= 1, 'tokenSparklines covers at least one token');
  for (const [token, points] of sparklineEntries) {
    assert.ok(Array.isArray(points), `tokenSparklines[${token}] is an array`);
    assert.ok(points.length >= 8, `tokenSparklines[${token}] has at least 8 points`);
    assert.ok(
      points.every((point) => typeof point === 'number' && Number.isFinite(point)),
      `tokenSparklines[${token}] points are finite numbers`,
    );
  }
};

test('feed-fixtures: FEED_FIXTURES shapes cover every shared mock dataset', () => {
  assertFixtureShapes(loadFeedFixtures());
});

test('FeedBox: bordered container with tone backgrounds, custom style merge and testID', async () => {
  const { FEED_TOKENS: tokens } = loadFeedDesign();
  const FeedBox = componentOf(loadFeedComponent('./components/ui/FeedBox.tsx'), 'FeedBox');

  let renderer = await mount(FeedBox, {}, React.createElement('Text', null, 'Balance'));
  assert.equal(renderer.root.findAllByType('Pressable' as never).length, 0, 'without onPress renders a plain View');
  const boxStyle = styleOfNode(renderer.root.findByType('View'));
  assert.equal(boxStyle.borderWidth, 1);
  assert.equal(boxStyle.borderColor, tokens.colors.border);
  assert.equal(boxStyle.borderRadius, 8);
  assert.equal(boxStyle.padding, 12);
  assert.equal(boxStyle.backgroundColor, tokens.colors.ground);
  assert.ok(textNodes(renderer).includes('Balance'));

  renderer = await mount(FeedBox, { tone: 'card', style: { margin: 4 } }, React.createElement('Text'));
  const cardStyle = styleOfNode(renderer.root.findByType('View'));
  assert.equal(cardStyle.backgroundColor, tokens.colors.card);
  assert.equal(cardStyle.margin, 4, 'explicit style merges in');
  assert.equal(cardStyle.padding, 12, 'explicit style keeps the base chrome');

  renderer = await mount(FeedBox, { tone: 'lift' });
  assert.equal(styleOfNode(renderer.root.findByType('View')).backgroundColor, tokens.colors.lift);
});

test('FeedBox: pressing the pressable variant calls onPress', async () => {
  const { FEED_TOKENS: tokens } = loadFeedDesign();
  const FeedBox = componentOf(loadFeedComponent('./components/ui/FeedBox.tsx'), 'FeedBox');

  let pressCount = 0;
  const renderer = await mount(
    FeedBox,
    { onPress: () => { pressCount += 1; }, testID: 'wallet-box' },
    React.createElement('Text', null, 'Net worth'),
  );
  const pressable = renderer.root.findByType('Pressable');
  const pressableStyle = styleOfNode(pressable);
  assert.equal(pressableStyle.borderWidth, 1);
  assert.equal(pressableStyle.borderColor, tokens.colors.border);
  assert.equal(pressableStyle.borderRadius, 8);
  assert.equal(pressableStyle.padding, 12);
  assert.equal(pressableStyle.backgroundColor, tokens.colors.ground);
  assert.equal(renderer.root.findAllByProps({ testID: 'wallet-box' }).length, 1);
  assert.ok(textNodes(renderer).includes('Net worth'));

  await pressNode(pressable, 'FeedBox');
  assert.equal(pressCount, 1);
});

test('SectionHeader: 700 title and gated accent link that reports presses', async () => {
  const { FEED_TOKENS: tokens } = loadFeedDesign();
  const SectionHeader = componentOf(loadFeedComponent('./components/ui/SectionHeader.tsx'), 'SectionHeader');

  let linkPressCount = 0;
  let renderer = await mount(
    SectionHeader,
    { title: 'Upcoming', linkLabel: 'All updates →', onLinkPress: () => { linkPressCount += 1; } },
  );
  const title = renderer.root.findAllByType('Text' as never).find((node) => node.props.children === 'Upcoming');
  assert.ok(title, 'title text rendered');
  const titleStyle = styleOfNode(title);
  assert.equal(titleStyle.fontSize, 20);
  assert.equal(titleStyle.fontWeight, '700');
  assert.equal(titleStyle.color, tokens.colors.text);

  const link = renderer.root.findAllByType('Text' as never).find((node) => node.props.children === 'All updates →');
  assert.ok(link, 'link label rendered as-is');
  const linkStyle = styleOfNode(link);
  assert.equal(linkStyle.color, tokens.colors.accent);
  assert.equal(linkStyle.fontSize, 11);

  await pressNode(link, 'SectionHeader link');
  assert.equal(linkPressCount, 1);

  renderer = await mount(SectionHeader, { title: 'Upcoming' });
  const texts = textNodes(renderer);
  assert.ok(texts.includes('Upcoming'));
  assert.equal(texts.includes('All updates →'), false, 'no link label renders without linkLabel');
  const hasAccentText = renderer.root.findAllByType('Text' as never)
    .some((node) => styleOfNode(node).color === tokens.colors.accent);
  assert.equal(hasAccentText, false, 'no accent text renders without linkLabel');
});

test('SegmentedTabs: active/inactive states and presses report the option key', async () => {
  const { FEED_TOKENS: tokens } = loadFeedDesign();
  const SegmentedTabs = componentOf(loadFeedComponent('./components/ui/SegmentedTabs.tsx'), 'SegmentedTabs');

  const options = [
    { key: 'reports', label: 'Reports' },
    { key: 'updates', label: 'Updates' },
    { key: 'events', label: 'Events' },
  ];
  const value = 'reports';
  const pressedKeys: string[] = [];
  const renderer = await mount(
    SegmentedTabs,
    { options, value, onChange: (key: string) => { pressedKeys.push(key); } },
  );

  const segments = renderer.root.findAllByProps({ accessibilityRole: 'tab' });
  assert.equal(segments.length, options.length, 'every option renders as a tab segment');

  const segmentByLabel = (label: string) => segments.find((node) => textFromJson(node.toJSON()).includes(label));
  for (const option of options) {
    const segment = segmentByLabel(option.label);
    assert.ok(segment, `segment for ${option.label} rendered`);
    assert.equal(
      (segment.props.accessibilityState as { selected?: boolean } | undefined)?.selected,
      option.key === value,
      `${option.label} accessibilityState.selected`,
    );
  }

  const active = segmentByLabel('Reports');
  assert.equal(styleOfNode(active).backgroundColor, tokens.colors.lift, 'active segment has the lifted background');
  for (const label of ['Updates', 'Events']) {
    const segment = segmentByLabel(label);
    const segmentStyle = styleOfNode(segment);
    assert.equal(segmentStyle.backgroundColor ?? null, null, `${label} segment has no background`);
  }

  const labelColors: Record<string, string | undefined> = {};
  for (const option of options) {
    const labelNode = renderer.root.findAllByType('Text' as never).find((node) => node.props.children === option.label);
    assert.ok(labelNode, `label for ${option.label} rendered`);
    labelColors[option.key] = styleOfNode(labelNode).color as string | undefined;
  }
  assert.equal(labelColors.reports, tokens.colors.text);
  assert.equal(labelColors.updates, tokens.colors.textDim);
  assert.equal(labelColors.events, tokens.colors.textDim);

  const outer = renderer.root.findAllByType('View' as never).find((node) => {
    const style = styleOfNode(node);
    return style.borderWidth === 1 && style.borderRadius === 6 && style.padding === 2;
  });
  assert.ok(outer, 'outer segmented box carries the shared chrome');

  const eventsSegment = segmentByLabel('Events');
  await pressNode(eventsSegment, 'inactive segment');
  assert.deepEqual(pressedKeys, ['events']);
});

test('FeedSheet: modal shell with backdrop close, grabber and no Close label; hidden when not visible', async () => {
  const { FEED_TOKENS: tokens } = loadFeedDesign();
  const FeedSheet = componentOf(loadFeedComponent('./components/ui/FeedSheet.tsx'), 'FeedSheet');

  let closeCount = 0;
  const renderer = await mount(
    FeedSheet,
    { visible: true, onClose: () => { closeCount += 1; } },
    React.createElement('Text', null, 'Story'),
  );

  const modal = renderer.root.findByType('Modal');
  assert.equal(modal.props.visible, true);
  assert.equal(modal.props.transparent, true);
  assert.equal(modal.props.animationType, 'slide');

  const backdrops = renderer.root.findAllByProps({ testID: 'feed-sheet-backdrop' });
  assert.equal(backdrops.length, 1);
  assert.equal(styleOfNode(backdrops[0]).backgroundColor, tokens.colors.backdrop);

  const grabbers = renderer.root.findAllByProps({ testID: 'feed-sheet-grabber' });
  assert.equal(grabbers.length, 1);
  const grabberStyle = styleOfNode(grabbers[0]);
  assert.equal(grabberStyle.width, 36);
  assert.equal(grabberStyle.height, 4);

  const sheet = renderer.root.findAllByType('View' as never).find((node) => {
    const style = styleOfNode(node);
    return style.height === '90%' && style.backgroundColor === tokens.colors.ground;
  });
  assert.ok(sheet, 'sheet body rendered');
  const sheetStyle = styleOfNode(sheet);
  assert.equal(sheetStyle.borderTopLeftRadius, 12);
  assert.equal(sheetStyle.borderTopRightRadius, 12);
  assert.equal(sheetStyle.borderWidth, 1);
  assert.equal(sheetStyle.borderColor, tokens.colors.border);

  await pressNode(backdrops[0], 'backdrop');
  assert.equal(closeCount, 1);
  await act(async () => { (modal.props.onRequestClose as () => void)(); });
  assert.equal(closeCount, 2);

  const texts = textNodes(renderer);
  assert.ok(texts.includes('Story'));
  assert.ok(!texts.includes('Close'), 'sheet does not render a Close label');

  const hidden = await mount(FeedSheet, { visible: false, onClose: () => {} });
  assert.equal(hidden.root.findByType('Modal').props.visible, false);
});

test('SampleDataLabel and MockOnly gate the sample tag on the mocks flag', async () => {
  const { FEED_TOKENS: tokens } = loadFeedDesign();
  const labelComponent = './components/ui/SampleDataLabel.tsx';
  const disabledUi = loadFeedComponent(labelComponent);
  const SampleDataLabel = componentOf(disabledUi, 'SampleDataLabel');
  const MockOnly = componentOf(disabledUi, 'MockOnly');

  let renderer = await mount(SampleDataLabel, {});
  assert.equal(renderer.toJSON(), null, 'labels stay hidden when mocks are off by default');
  renderer = await mount(SampleDataLabel, { enabled: false });
  assert.equal(renderer.toJSON(), null, 'explicit disabled hides the label');

  renderer = await mount(SampleDataLabel, { enabled: true });
  const label = renderer.root.findAllByType('Text' as never).find((node) => node.props.children === 'SAMPLE DATA');
  assert.ok(label, 'SAMPLE DATA text rendered');
  const labelStyle = styleOfNode(label);
  assert.equal(labelStyle.fontSize, 11);
  assert.equal(labelStyle.color, tokens.colors.textFaint);
  assert.equal(labelStyle.borderRadius, 4); // chip

  const enabledUi = loadFeedComponent(labelComponent, { feedMocksEnv: '1' });
  const sampleLabelDefaultEnabled = componentOf(enabledUi, 'SampleDataLabel');
  assert.notEqual(
    (await mount(sampleLabelDefaultEnabled, {})).toJSON(),
    null,
    'label shows by default when EXPO_PUBLIC_FEED_MOCKS is on',
  );

  renderer = await mount(MockOnly, {}, React.createElement('Text', null, 'Portfolio'));
  assert.equal(renderer.toJSON(), null, 'MockOnly stays hidden when mocks are off by default');

  renderer = await mount(MockOnly, { enabled: true }, React.createElement('Text', null, 'Portfolio'));
  let texts = textNodes(renderer);
  assert.ok(texts.includes('Portfolio'), 'MockOnly renders its children when enabled');
  assert.ok(texts.includes('SAMPLE DATA'), 'MockOnly adds the sample tag when enabled');

  const mockOnlyDefaultEnabled = componentOf(enabledUi, 'MockOnly');
  renderer = await mount(mockOnlyDefaultEnabled, {}, React.createElement('Text', null, 'Portfolio'));
  texts = textNodes(renderer);
  assert.ok(texts.includes('Portfolio'), 'MockOnly default follows the flag (env on)');
  assert.ok(texts.includes('SAMPLE DATA'));
});