import assert from 'node:assert/strict';
import test from 'node:test';
import { getInitialFeedRenderCount } from './predict-feed';

test('web retains every published sport section in the initial render region', () => {
  const sections = [
    { data: Array.from({ length: 2 }) },
    { data: Array.from({ length: 15 }) },
    { data: Array.from({ length: 19 }) },
  ];

  assert.equal(getInitialFeedRenderCount(sections, true), 42);
});

test('native keeps the SectionList virtualization default', () => {
  assert.equal(getInitialFeedRenderCount([{ data: Array.from({ length: 36 }) }], false), undefined);
});
