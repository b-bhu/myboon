import assert from 'node:assert/strict'
import test from 'node:test'
import { entityIdentityShadowFixtures } from './entity-identity-shadow'

test('scoped shared-gateway fixtures cover polluted aliases, a legitimate split, and a duplicate', () => {
  const fixtures = entityIdentityShadowFixtures()
  assert.deepEqual(fixtures.map((item) => item.expectedDecision), [
    'polluted_alias', 'polluted_alias', 'different_entities', 'same_entity',
  ])
  assert.equal(new Set(fixtures.map((item) => item.candidate.pairKey)).size, fixtures.length)
})
