import assert from 'node:assert/strict'
import test from 'node:test'
import { automaticCleanupEligible, findingFromJudgment } from './decision-policy'
import type { EntityIdentityJudgment, EntityMaintenanceCandidate } from './contracts'
import { maintenanceProfile } from './test-helpers'

function pollutedCandidate(): EntityMaintenanceCandidate {
  return {
    pairKey: 'gpt:solana',
    left: maintenanceProfile({
      id: 'gpt', name: 'GPT-5.6', slug: 'openai-gpt-5-6', type: 'product', aliases: ['Solana'],
    }),
    right: maintenanceProfile({
      id: 'solana', name: 'Solana', slug: 'solana', type: 'asset', aliases: ['SOL'],
    }),
    signals: [{ kind: 'name_alias', label: 'solana' }],
  }
}

function pollutedJudgment(overrides: Partial<EntityIdentityJudgment> = {}): EntityIdentityJudgment {
  return {
    pairKey: 'gpt:solana',
    decision: 'polluted_alias',
    confidence: 0.95,
    reason: 'Unrelated subjects.',
    pollutedEntityId: 'gpt',
    pollutedAlias: 'Solana',
    ...overrides,
  }
}

test('polluted aliases remain reviewable but never become automatically eligible', () => {
  const candidate = pollutedCandidate()
  const judgment = pollutedJudgment()

  assert.equal(automaticCleanupEligible(candidate, judgment), false)
  assert.equal(findingFromJudgment('run-1', candidate, judgment).autoApplyEligible, false)
})

test('alias automation stays off regardless of confidence or structural shape', () => {
  const base = pollutedCandidate()
  assert.equal(automaticCleanupEligible(base, pollutedJudgment({ confidence: 1 })), false)
  assert.equal(automaticCleanupEligible(base, pollutedJudgment({ pollutedAlias: 'SOL' })), false)
  assert.equal(automaticCleanupEligible({
    ...base,
    right: { ...base.right, type: 'product' },
  }, pollutedJudgment()), false)
  assert.equal(automaticCleanupEligible({
    ...base,
    left: { ...base.left, showInCarousel: true },
  }, pollutedJudgment()), false)
})
