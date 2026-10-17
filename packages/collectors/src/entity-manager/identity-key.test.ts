import assert from 'node:assert/strict'
import test from 'node:test'
import { entityIdentityKey, entityIdentityKeys, entityIdentityLookupLabels } from './identity-key'

test('entityIdentityKey normalises names, casing and trailing parentheticals', () => {
  assert.equal(entityIdentityKey('Bitcoin (BTC)'), 'bitcoin')
  assert.equal(entityIdentityKey('  BITCOIN '), 'bitcoin')
  assert.equal(entityIdentityKey('Bitcoin ETF'), 'bitcoinetf')
  assert.equal(entityIdentityKey('bitcoin-etf'), 'bitcoinetf')
  assert.equal(entityIdentityKey('U.S.–Iran Conflict'), 'usiranconflict')
  assert.equal(entityIdentityKey('(BTC)'), 'btc')
  assert.equal(entityIdentityKey(''), '')
})

test('entityIdentityKey removes exactly one trailing parenthetical group', () => {
  assert.equal(entityIdentityKey('Bitcoin (BTC)'), 'bitcoin')
  assert.equal(entityIdentityKey('Bitcoin (BTC) (ETF)'), 'bitcoinbtc')
  assert.equal(entityIdentityKey('Bitcoin (BTC)'), 'bitcoin')
  // Nothing non-empty remains before the parenthetical, so it keeps its own identity.
  assert.equal(entityIdentityKey('(BTC)'), 'btc')
})

test('entityIdentityKeys collects non-empty keys and drops duplicates', () => {
  assert.deepEqual([...entityIdentityKeys(['Bitcoin (BTC)', '  BITCOIN ', '', '  '])], ['bitcoin'])
  assert.deepEqual([...entityIdentityKeys([])], [])
})

test('entityIdentityLookupLabels follows each value with its base name', () => {
  assert.deepEqual(entityIdentityLookupLabels(['Bitcoin (BTC)']), ['Bitcoin (BTC)', 'Bitcoin'])
  assert.deepEqual(entityIdentityLookupLabels(['Bitcoin (BTC)', 'Bitcoin', '   ']), ['Bitcoin (BTC)', 'Bitcoin'])
  assert.deepEqual(entityIdentityLookupLabels(['  Bitcoin   (BTC) ', '']), ['Bitcoin (BTC)', 'Bitcoin'])
  // A value with no base before the parenthetical gains no variant.
  assert.deepEqual(entityIdentityLookupLabels(['(BTC)', 'a  ', '  ']), ['(BTC)', 'a'])
  assert.deepEqual(entityIdentityLookupLabels([]), [])
})