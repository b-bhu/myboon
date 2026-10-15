import assert from 'node:assert/strict'
import test from 'node:test'
import { Lru } from './lru.js'

test('LRU evicts by entry count and byte ceiling', () => {
  const byCount = new Lru<string, string>({ maxEntries: 2, ttlMs: 100, now: () => 0 })
  byCount.set('a', 'a'); byCount.set('b', 'b'); byCount.get('a'); byCount.set('c', 'c')
  assert.equal(byCount.get('b'), undefined)
  assert.equal(byCount.get('a'), 'a')
  const byBytes = new Lru<string, string>({ maxEntries: 10, maxBytes: 3, sizeOf: (v) => v.length, ttlMs: 100, now: () => 0 })
  byBytes.set('a', 'aa'); byBytes.set('b', 'bb')
  assert.equal(byBytes.get('a'), undefined)
  assert.equal(byBytes.byteSize, 2)
})

test('LRU entries expire by their TTL', () => {
  let now = 5
  const lru = new Lru<string, string>({ maxEntries: 4, ttlMs: 3, now: () => now })
  lru.set('x', 'v'); now = 8
  assert.equal(lru.get('x'), undefined)
  assert.equal(lru.size, 0)
})
