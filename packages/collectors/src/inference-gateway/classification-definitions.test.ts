import assert from 'node:assert/strict'
import test from 'node:test'
import { entityIdentityShadowFixtures } from '../entity-maintenance/entity-identity-shadow'
import {
  entityCatalogIdentityDefinition,
  researchNoveltyDefinition,
  type EntityCatalogIdentityState,
  type ResearchNoveltyState,
} from './classification-definitions'

test('Entity catalogue definition locates an exact polluted alias and fails closed without it', () => {
  const definition = entityCatalogIdentityDefinition()
  const state: EntityCatalogIdentityState = { candidate: entityIdentityShadowFixtures()[0]!.candidate }
  const accepted = definition.decodeJev({
    identity: { type: 'choice', choice: 'polluted_alias', confidence: 0.99, probabilities: {
      same_entity: 0, different_entities: 0.01, unsure: 0, polluted_alias: 0.99,
    } },
    polluted_alias: { type: 'choice', choice: 'left_alias_1', confidence: 1, probabilities: {
      none: 0, left_alias_0: 0, left_alias_1: 1, right_alias_0: 0,
    } },
  }, state)
  assert.equal(accepted.valid, true)
  if (accepted.valid) {
    assert.equal(accepted.value.pollutedEntityId, 'entity-gpt-5-6')
    assert.equal(accepted.value.pollutedAlias, 'Solana')
  }
  const rejected = definition.decodeJev({
    identity: { type: 'choice', choice: 'polluted_alias', confidence: 1, probabilities: {
      same_entity: 0, different_entities: 0, unsure: 0, polluted_alias: 1,
    } },
    polluted_alias: { type: 'choice', choice: 'none', confidence: 1, probabilities: { none: 1 } },
  }, state)
  assert.equal(rejected.valid, false)
  const hermes = definition.validateHermes({
    schemaVersion: 'myboon.entity_identity_classification.v1',
    decision: {
      pairKey: state.candidate.pairKey,
      decision: 'polluted_alias',
      reason: 'The stored Solana alias names the network.',
      pollutedEntityId: 'entity-gpt-5-6',
      pollutedAlias: 'Solana',
    },
  }, state)
  assert.equal(hermes.valid, true, 'Hermes decision is accepted without inventing or requiring confidence')
})

test('Research novelty definition is bounded to novelty and defaults fail-safe disabled', () => {
  const definition = researchNoveltyDefinition()
  assert.equal(definition.defaultLifecycleMode, 'disabled')
  assert.equal(definition.maximumLifecycleMode, 'canary')
  const state: ResearchNoveltyState = {
    signal: { source: 'news', sourceRefId: 'article-1', title: 'SEC update', whatChanged: 'SEC approved a conditional exemption.', observedAt: '2026-09-23T00:00:00.000Z' },
    context: {
      entities: [{ id: 'sec', slug: 'sec', name: 'SEC', summary: null }],
      recentMemories: [{ entityId: 'sec', memoryType: 'news', title: 'Earlier filing', summary: 'The SEC was considering an exemption.', eventAt: '2026-09-20T00:00:00.000Z' }],
    },
  }
  assert.equal(definition.validateState(state).valid, true)
  assert.match(definition.renderHermes(state), /Do not judge importance/)
  const decoded = definition.decodeJev({ novelty: {
    type: 'choice', choice: 'new_information', confidence: 0.95,
    probabilities: { already_known: 0.03, new_information: 0.95, contradicts_prior: 0.02 },
  } }, state)
  assert.deepEqual(decoded, { valid: true, value: { verdict: 'new_information', reason: 'Jev classified the signal as new_information.' } })
})
