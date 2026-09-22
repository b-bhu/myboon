import assert from 'node:assert/strict'
import test from 'node:test'
import { buildEntityMaintenanceCandidates, normalizedIdentity } from './candidates'
import { autoMergeEligible } from './decision-policy'
import { maintenanceProfile } from './test-helpers'

test('candidate discovery scans the catalogue locally and finds exact canonical-name duplicates', () => {
  const candidates = buildEntityMaintenanceCandidates([
    maintenanceProfile({ id: 'acme-1', name: 'Acme Labs', aliases: ['Acme'] }),
    maintenanceProfile({ id: 'acme-2', name: 'ACME Labs', aliases: [] }),
    maintenanceProfile({ id: 'other', name: 'Completely Different' }),
  ])

  assert.equal(candidates.length, 1)
  assert.equal(candidates[0]?.pairKey, 'acme-1:acme-2')
  assert.ok(candidates[0]?.signals.some((signal) => signal.kind === 'exact_name'))
})

test('network and native asset remain separate even when a ticker is stored as an alias', () => {
  const candidates = buildEntityMaintenanceCandidates([
    maintenanceProfile({ id: 'solana', name: 'Solana', type: 'network', aliases: ['SOL'] }),
    maintenanceProfile({ id: 'sol', name: 'SOL', type: 'asset', aliases: [] }),
  ])

  assert.equal(candidates.length, 1)
  assert.ok(candidates[0]?.signals.some((signal) => signal.kind === 'name_alias'))
  assert.equal(autoMergeEligible(candidates[0]!, {
    pairKey: candidates[0]!.pairKey,
    decision: 'same_entity',
    confidence: 1,
    reason: 'incorrect model judgment',
    pollutedEntityId: null,
    pollutedAlias: null,
  }), false)
})

test('a polluted alias creates an audit candidate without granting merge authority', () => {
  const candidates = buildEntityMaintenanceCandidates([
    maintenanceProfile({ id: 'gpt', name: 'GPT-5.6', type: 'product', aliases: ['Solana'] }),
    maintenanceProfile({ id: 'solana', name: 'Solana', type: 'network', aliases: ['SOL'] }),
  ])

  assert.equal(candidates.length, 1)
  assert.deepEqual(candidates[0]?.signals, [{ kind: 'name_alias', label: 'solana' }])
})

test('large alias-only buckets do not explode into quadratic Hermes work', () => {
  const profiles = Array.from({ length: 20 }, (_, index) => maintenanceProfile({
    id: `entity-${String(index).padStart(2, '0')}`,
    name: `Distinct Entity ${index}`,
    aliases: ['crypto'],
  }))
  const candidates = buildEntityMaintenanceCandidates(profiles)
  assert.equal(candidates.some((candidate) => (
    candidate.signals.some((signal) => signal.kind === 'shared_alias' && signal.label === 'crypto')
  )), false)
})

test('identity normalization is deterministic across punctuation and case', () => {
  assert.equal(normalizedIdentity('  GPT–5.6 '), 'gpt 5 6')
  assert.equal(normalizedIdentity('GPT_5-6'), 'gpt 5 6')
})

test('archived merge sources never re-enter duplicate discovery', () => {
  const candidates = buildEntityMaintenanceCandidates([
    maintenanceProfile({ id: 'canonical', name: 'Acme' }),
    maintenanceProfile({ id: 'redirect-source', name: 'ACME', status: 'archived' }),
  ])

  assert.deepEqual(candidates, [])
})
