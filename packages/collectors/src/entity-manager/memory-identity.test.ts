import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MEMORY_IDENTITY_VERSION,
  MemoryIdentityValidationError,
  deriveMemoryIdentityKey,
  type MemoryIdentityInput,
} from './memory-identity'

function identityInput(overrides: Partial<MemoryIdentityInput> = {}): MemoryIdentityInput {
  return {
    packet: {
      packetId: 'packet-1',
      workId: 'work-1',
      signalId: 'signal-1',
      researchContractVersion: 'myboon.research_packet.v1',
      sourceType: 'news',
      sourceSignal: { sourceId: 'article-1' },
    },
    canonicalEntityId: 'entity-1',
    memoryType: 'news_event',
    memoryRole: 'primary_event',
    representedClaimIds: ['claim-b', 'claim-a'],
    representedEvidenceIds: ['evidence-b', 'evidence-a'],
    ...overrides,
  }
}

test('identity is a versioned SHA-256 key independent of generated wording', () => {
  const first = deriveMemoryIdentityKey({
    ...identityInput(),
    title: 'First generated title',
  } as MemoryIdentityInput)
  const second = deriveMemoryIdentityKey({
    ...identityInput({
      representedClaimIds: ['claim-a', 'claim-b', 'claim-a'],
      representedEvidenceIds: ['evidence-a', 'evidence-b', 'evidence-b'],
    }),
    title: 'Entirely different generated wording',
  } as MemoryIdentityInput)

  assert.equal(first, second)
  assert.match(first, new RegExp(`^${MEMORY_IDENTITY_VERSION.replaceAll('.', '\\.')}:[a-f0-9]{64}$`))
})

test('one packet/article and canonical Entity has one identity across model-authored memory choices', () => {
  const baseline = deriveMemoryIdentityKey(identityInput())
  const variants = [
    identityInput({ memoryType: 'market_signal' }),
    identityInput({ memoryRole: 'supporting_context' }),
    identityInput({ representedClaimIds: ['claim-c'] }),
    identityInput({ representedEvidenceIds: ['evidence-c'] }),
    {
      ...identityInput({
        memoryType: 'research_note',
        memoryRole: 'alternate_valid_role',
        representedClaimIds: ['claim-z'],
        representedEvidenceIds: [],
      }),
      title: 'A completely different generated title',
    } as MemoryIdentityInput,
  ]

  for (const variant of variants) assert.equal(deriveMemoryIdentityKey(variant), baseline)
})

test('one news article remains stable across packet, work, and contract changes', () => {
  const baseline = deriveMemoryIdentityKey(identityInput())
  const variants: MemoryIdentityInput[] = [
    identityInput({ packet: { ...identityInput().packet, packetId: 'packet-2' } }),
    identityInput({ packet: { ...identityInput().packet, workId: 'work-2' } }),
    identityInput({ packet: { ...identityInput().packet, researchContractVersion: 'myboon.research_packet.v2' } }),
  ]

  for (const variant of variants) assert.equal(deriveMemoryIdentityKey(variant), baseline)
})

test('news source article or Entity changes alter identity', () => {
  const baseline = deriveMemoryIdentityKey(identityInput())
  assert.notEqual(deriveMemoryIdentityKey(identityInput({
    packet: { ...identityInput().packet, sourceSignal: { sourceId: 'article-2' } },
  })), baseline)
  assert.notEqual(deriveMemoryIdentityKey(identityInput({ canonicalEntityId: 'entity-2' })), baseline)
})

test('non-news identity remains packet-scoped', () => {
  const polymarket = identityInput({
    packet: { ...identityInput().packet, sourceType: 'polymarket' },
  })
  assert.notEqual(deriveMemoryIdentityKey(polymarket), deriveMemoryIdentityKey({
    ...polymarket,
    packet: { ...polymarket.packet, packetId: 'packet-2' },
  }))
})

test('non-identity memory metadata remains validated', () => {
  assert.throws(
    () => deriveMemoryIdentityKey(identityInput({ representedClaimIds: [], representedEvidenceIds: [] })),
    MemoryIdentityValidationError,
  )
  assert.throws(
    () => deriveMemoryIdentityKey(identityInput({ canonicalEntityId: ' ' })),
    MemoryIdentityValidationError,
  )
  assert.throws(
    () => deriveMemoryIdentityKey(identityInput({ memoryType: 'source_marker' as never })),
    /Unsupported memoryType/,
  )
  assert.throws(
    () => deriveMemoryIdentityKey(identityInput({ memoryRole: ' ' })),
    /memoryRole must be a non-empty string/,
  )
  assert.throws(
    () => deriveMemoryIdentityKey(identityInput({ representedClaimIds: [' '] })),
    /representedClaimIds must be a non-empty string/,
  )
})
