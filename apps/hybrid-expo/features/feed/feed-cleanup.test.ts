import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as state from './feed-state';

const here = __dirname;

const removedFiles = [
  'components/BottomGlassNav.tsx',
  'components/FeedSkeleton.tsx',
  'components/ProgressBar.tsx',
  'components/MarketCalendarModal.tsx',
  'components/market-calendar.tsx',
  'components/feed-detail-sheet.tsx',
];

test('dead feed component files are removed', () => {
  for (const relative of removedFiles) {
    const file = path.join(here, relative);
    assert.equal(fs.existsSync(file), false, `${relative} should no longer exist`);
  }
});

test('feed-state no longer exports calendar helpers', () => {
  assert.equal('calendarPeriod' in state, false, 'calendarPeriod should be removed from feed-state');
  assert.equal('shiftCalendarDate' in state, false, 'shiftCalendarDate should be removed from feed-state');
});

test('feed.api.ts no longer declares dead predict/explanation helpers', () => {
  const source = fs.readFileSync(path.join(here, 'feed.api.ts'), 'utf8');
  for (const name of ['fetchPredictMarket', 'fetchSimpleExplanation', 'detectSlugType', 'extractSport', 'getApiBaseUrl']) {
    assert.doesNotMatch(source, new RegExp(`\\b${name}\\b`), `${name} should be removed from feed.api.ts`);
  }
});

const deadModuleNames = ['MarketCalendarModal', 'market-calendar', 'feed-detail-sheet', 'BottomGlassNav', 'FeedSkeleton', 'ProgressBar'];

function walk(dir: string): string[] {
  const found: string[] = [];
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...walk(full));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

test('no file under features/ or app/ references the removed feed modules', () => {
  const roots = [path.join(here, '..'), path.join(here, '..', '..', 'app')];
  const files = roots.flatMap((root) => walk(root))
    .filter((file) => !file.endsWith('feed-cleanup.test.ts'));
  const offenders: string[] = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const name of deadModuleNames) {
      if (new RegExp(`\\b${name}\\b`).test(text)) offenders.push(`${file}: ${name}`);
    }
  }
  assert.deepEqual(offenders, []);
});