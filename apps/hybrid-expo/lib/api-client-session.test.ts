import assert from 'node:assert/strict';
import test from 'node:test';
import { apiClientSessionHeaders } from './api-client-session';

test('API client session headers are lazy, stable, and server-render safe', () => {
  assert.equal(typeof (globalThis as { window?: unknown }).window, 'undefined');

  const first = apiClientSessionHeaders();
  const second = apiClientSessionHeaders();

  assert.equal(first['x-myboon-client'], 'hybrid-expo-v1');
  assert.equal(first['x-myboon-session'], second['x-myboon-session']);
  assert.ok(first['x-myboon-session'].length > 8);
  assert.ok(first['x-myboon-session'].length <= 160);
});
