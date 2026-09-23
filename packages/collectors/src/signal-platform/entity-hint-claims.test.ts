import assert from 'node:assert/strict'
import test from 'node:test'
import type { EntityHint, ResearchClaim } from './contracts'
import { deriveEntityHintClaimRefs } from './entity-hint-claims'

const claims: ResearchClaim[] = [{
  claimId: 'claim-solana',
  claim: 'Solana held above $100 as SOL demand rose.',
  attributedTo: 'Solana',
  evidenceRefs: ['shared-article'],
}, {
  claimId: 'claim-sec',
  claim: 'The SEC approved a tokenized-stock exemption.',
  attributedTo: 'SEC',
  evidenceRefs: ['shared-article'],
}]

function hint(overrides: Partial<EntityHint>): EntityHint {
  return {
    name: 'Solana (SOL)',
    type: null,
    role: 'subject',
    aliases: ['SOL'],
    source: 'research',
    claimRefs: [],
    evidenceRefs: ['shared-article'],
    ...overrides,
  }
}

test('derives claim-level Entity support instead of treating shared article evidence as relevance', () => {
  const [solana, sec] = deriveEntityHintClaimRefs([
    hint({}),
    hint({ name: 'SEC', aliases: [] }),
  ], claims)

  assert.deepEqual(solana.claimRefs, ['claim-solana'])
  assert.deepEqual(sec.claimRefs, ['claim-sec'])
  assert.deepEqual(solana.evidenceRefs, ['shared-article'])
  assert.deepEqual(sec.evidenceRefs, ['shared-article'])
})

test('ticker matching is case-sensitive and uses identity boundaries', () => {
  const [result] = deriveEntityHintClaimRefs([hint({ name: 'SOL', aliases: [] })], [{
    claimId: 'claim-title-case',
    claim: 'Sol is discussed, but no ticker is named.',
    attributedTo: null,
    evidenceRefs: ['shared-article'],
  }])

  assert.deepEqual(result.claimRefs, [])
})

test('recomputation ignores aliases and replaces supplied historical claim refs', () => {
  const [result] = deriveEntityHintClaimRefs([hint({
    name: 'GPT-5.6',
    type: 'product',
    aliases: ['Solana'],
    claimRefs: ['claim-solana'],
  })], claims)

  assert.deepEqual(result.claimRefs, [])
})

test('model-owned attribution cannot establish Entity claim authority by itself', () => {
  const [result] = deriveEntityHintClaimRefs([hint({
    name: 'GPT-5.6',
    type: 'product',
    aliases: [],
  })], [{
    claimId: 'claim-unrelated',
    claim: 'Solana held above $100.',
    attributedTo: 'GPT-5.6',
    evidenceRefs: ['shared-article'],
  }])

  assert.deepEqual(result.claimRefs, [])
})
