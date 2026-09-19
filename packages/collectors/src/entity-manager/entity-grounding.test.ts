import assert from 'node:assert/strict'
import test from 'node:test'
import type { EntityHint } from '../signal-platform/contracts'
import { groundEntityCandidates } from './entity-grounding'
import type { EntityRecord } from './types'

function entity(overrides: Partial<EntityRecord> = {}): EntityRecord {
  return {
    id: overrides.id ?? 'entity-1',
    slug: overrides.slug ?? 'example',
    name: overrides.name ?? 'Example',
    type: overrides.type ?? 'organization',
    aliases: overrides.aliases ?? [],
    summary: overrides.summary ?? null,
    status: overrides.status ?? 'active',
    show_in_carousel: overrides.show_in_carousel ?? true,
    metadata: overrides.metadata ?? {},
  }
}

function hint(overrides: Partial<EntityHint> = {}): EntityHint {
  return {
    name: overrides.name ?? 'Example',
    type: Object.prototype.hasOwnProperty.call(overrides, 'type') ? overrides.type ?? null : null,
    role: Object.prototype.hasOwnProperty.call(overrides, 'role') ? overrides.role ?? null : 'subject',
    aliases: overrides.aliases ?? [],
    source: overrides.source ?? 'research',
    claimRefs: overrides.claimRefs ?? ['claim-1'],
    evidenceRefs: overrides.evidenceRefs ?? [],
  }
}

test('canonical Solana wins over GPT-5.6 aliases for the live Solana (SOL) subject hint', () => {
  const solana = entity({
    id: 'entity-solana',
    slug: 'solana',
    name: 'Solana',
    type: 'asset',
    aliases: ['Solana', 'SOL', '@Solana'],
  })
  const gpt = entity({
    id: 'entity-gpt-5-6',
    slug: 'openai-gpt-5-6',
    name: 'GPT-5.6',
    type: 'product',
    aliases: ['Sol', 'Solana', '@Solana'],
  })

  const result = groundEntityCandidates([gpt, solana], [hint({
    name: 'Solana (SOL)',
    role: 'subject of report',
    aliases: ['SOL'],
  })])

  assert.deepEqual(result.candidates.map((candidate) => candidate.id), ['entity-solana'])
  const solanaSupport = result.support.find((item) => item.entityId === solana.id)
  const gptSupport = result.support.find((item) => item.entityId === gpt.id)
  assert.equal(solanaSupport?.primarySelectionAuthorized, true)
  assert.ok(solanaSupport?.matches.some((match) => (
    match.label === 'Solana'
      && match.matchKind === 'canonical_name'
      && match.decision === 'authoritative_canonical'
  )))
  assert.ok(solanaSupport?.matches.some((match) => (
    match.label === 'SOL'
      && match.matchKind === 'alias'
      && match.decision === 'authoritative_unique_alias'
  )))
  assert.ok(gptSupport?.matches.some((match) => (
    match.label === 'Solana'
      && match.matchKind === 'alias'
      && match.decision === 'suppressed_by_canonical'
  )))
  assert.equal(gptSupport?.primarySelectionAuthorized, false)
  assert.equal(gptSupport?.matches.some((match) => match.label === 'SOL'), false, '`SOL` must not match alias `Sol`')
})

test('an uppercase ticker does not case-fold into an unrelated title-case canonical slug', () => {
  const sol = entity({ id: 'entity-sol', slug: 'sol', name: 'Sol', aliases: [] })

  const result = groundEntityCandidates([sol], [hint({
    name: 'SOL',
    aliases: [],
    evidenceRefs: ['evidence-sol'],
    claimRefs: [],
  })])

  assert.deepEqual(result.candidates, [])
  assert.deepEqual(result.support, [])
})

test('a unique uppercase ticker alias is not authoritative without canonical corroboration', () => {
  const solana = entity({
    id: 'entity-solana',
    slug: 'solana',
    name: 'Solana',
    type: 'network',
    aliases: ['SOL'],
  })

  const result = groundEntityCandidates([solana], [hint({
    name: 'SOL',
    aliases: [],
    evidenceRefs: ['evidence-sol'],
    claimRefs: [],
  })])

  assert.deepEqual(result.candidates, [])
  assert.equal(result.support[0]?.matches[0]?.decision, 'non_authoritative_alias')
})

test('an unambiguous evidence-linked SEC alias authorizes its subject candidate', () => {
  const sec = entity({
    id: 'entity-sec',
    slug: 'us-securities-and-exchange-commission',
    name: 'U.S. Securities and Exchange Commission',
    aliases: ['SEC'],
  })

  const result = groundEntityCandidates([sec], [hint({
    name: 'SEC',
    aliases: [],
    evidenceRefs: ['evidence-sec'],
    claimRefs: [],
  })])

  assert.deepEqual(result.candidates.map((candidate) => candidate.id), [sec.id])
  assert.deepEqual(result.support, [{
    entityId: sec.id,
    primarySelectionAuthorized: true,
    supportingClaimIds: [],
    supportingEvidenceIds: ['evidence-sec'],
    matches: [{
      hintIndex: 0,
      label: 'SEC',
      labelSource: 'name',
      matchKind: 'alias',
      decision: 'authoritative_unique_alias',
      primarySelectionAuthorized: true,
      role: 'subject',
      hintType: null,
      entityType: 'organization',
      claimRefs: [],
      evidenceRefs: ['evidence-sec'],
    }],
  }])
})

test('a unique lexical alias cannot authorize an unrelated canonical Entity by itself', () => {
  const gpt = entity({
    id: 'entity-gpt',
    slug: 'openai-gpt-5-6',
    name: 'GPT-5.6',
    type: 'product',
    aliases: ['Solana'],
  })

  const result = groundEntityCandidates([gpt], [hint({
    name: 'Solana',
    claimRefs: [],
    evidenceRefs: ['evidence-solana'],
  })])

  assert.deepEqual(result.candidates, [])
  assert.equal(result.support[0]?.matches[0]?.decision, 'non_authoritative_alias')
})

test('a unique lexical abbreviation may authorize its structurally related canonical Entity', () => {
  const federalReserve = entity({
    id: 'entity-fed', slug: 'federal-reserve', name: 'Federal Reserve', aliases: ['Fed'],
  })

  const result = groundEntityCandidates([federalReserve], [hint({ name: 'Fed' })])

  assert.deepEqual(result.candidates.map((candidate) => candidate.id), [federalReserve.id])
  assert.equal(result.support[0]?.matches[0]?.decision, 'authoritative_unique_alias')
})

test('ambiguous alias-only matches are visible but cannot authorize primary selection', () => {
  const securitiesCommission = entity({
    id: 'entity-securities-commission',
    slug: 'securities-commission',
    name: 'Securities Commission',
    aliases: ['SEC'],
  })
  const energyCouncil = entity({
    id: 'entity-state-energy-council',
    slug: 'state-energy-council',
    name: 'State Energy Council',
    aliases: ['SEC'],
  })

  const result = groundEntityCandidates([securitiesCommission, energyCouncil], [hint({ name: 'SEC' })])

  assert.deepEqual(result.candidates, [])
  assert.deepEqual(result.support.map((item) => item.primarySelectionAuthorized), [false, false])
  assert.ok(result.support.every((item) => item.matches[0]?.decision === 'ambiguous_alias'))
})

test('unlinked, null-role, and explicit non-subject hints do not authorize candidates', () => {
  const publisher = entity({ id: 'entity-publisher', slug: 'publisher', name: 'Publisher' })
  const context = entity({ id: 'entity-context', slug: 'context', name: 'Context' })
  const mentioned = entity({ id: 'entity-mentioned', slug: 'mentioned', name: 'Mentioned' })
  const negated = entity({ id: 'entity-negated', slug: 'negated', name: 'Negated' })
  const unlinked = entity({ id: 'entity-unlinked', slug: 'unlinked', name: 'Unlinked' })

  const result = groundEntityCandidates([publisher, context, mentioned, negated, unlinked], [
    hint({ name: 'Publisher', role: 'publisher' }),
    hint({ name: 'Context', role: null }),
    hint({ name: 'Mentioned', role: 'mentioned subject' }),
    hint({ name: 'Negated', role: 'not subject' }),
    hint({ name: 'Unlinked', role: 'subject', claimRefs: [], evidenceRefs: [] }),
  ])

  assert.deepEqual(result.candidates, [])
  assert.deepEqual(result.support.map((item) => item.entityId), [
    'entity-context',
    'entity-mentioned',
    'entity-negated',
    'entity-publisher',
  ])
  assert.ok(result.support.every((item) => item.matches[0]?.decision === 'non_authoritative_role'))
  assert.equal(result.support.some((item) => item.entityId === unlinked.id), false)
})

test('clearly incompatible normalized hint and entity types are rejected', () => {
  const model = entity({
    id: 'entity-model',
    slug: 'network-example',
    name: 'Network Example',
    type: 'ai_model',
  })

  const result = groundEntityCandidates([model], [hint({
    name: 'Network Example',
    type: 'blockchain network',
  })])

  assert.deepEqual(result.candidates, [])
  assert.equal(result.support[0]?.matches[0]?.hintType, 'network')
  assert.equal(result.support[0]?.matches[0]?.entityType, 'product')
  assert.equal(result.support[0]?.matches[0]?.decision, 'incompatible_type')
})

test('network and blockchain types normalize compatibly during grounding', () => {
  const solana = entity({
    id: 'entity-solana-network',
    slug: 'solana',
    name: 'Solana',
    type: 'network',
  })

  const result = groundEntityCandidates([solana], [hint({
    name: 'Solana',
    type: 'blockchain',
  })])

  assert.deepEqual(result.candidates.map((candidate) => candidate.id), [solana.id])
  assert.equal(result.support[0]?.matches[0]?.hintType, 'network')
  assert.equal(result.support[0]?.matches[0]?.entityType, 'network')
  assert.equal(result.support[0]?.matches[0]?.decision, 'authoritative_canonical')
})
