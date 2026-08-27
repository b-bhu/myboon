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
      researchContractVersion: 'myboon.research_packet.v1',
    },
    canonicalEntityId: 'entity-1',
    memoryType: 'news_event',
    memoryRole: 'primary_event',
    representedClaimIds: ['claim-b', 'claim-a'],
    representedEvidenceIds: ['evidence-b', 'evidence-a'],
    ...overrides,
  }
}

test('identity is versioned SHA-256 and ignores represented ID ordering, duplicates, and generated wording', () => {
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

test('semantic packet, entity, type, role, claim, evidence, and contract changes alter identity', () => {
  const baseline = deriveMemoryIdentityKey(identityInput())
  const variants: MemoryIdentityInput[] = [
    identityInput({ packet: { packetId: 'packet-2', workId: 'work-1', researchContractVersion: 'myboon.research_packet.v1' } }),
    identityInput({ packet: { packetId: 'packet-1', workId: 'work-2', researchContractVersion: 'myboon.research_packet.v1' } }),
    identityInput({ packet: { packetId: 'packet-1', workId: 'work-1', researchContractVersion: 'myboon.research_packet.v2' } }),
    identityInput({ canonicalEntityId: 'entity-2' }),
    identityInput({ memoryType: 'market_signal' }),
    identityInput({ memoryRole: 'supporting_context' }),
    identityInput({ representedClaimIds: ['claim-c'] }),
    identityInput({ representedEvidenceIds: ['evidence-c'] }),
  ]

  for (const variant of variants) assert.notEqual(deriveMemoryIdentityKey(variant), baseline)
})

test('identity requires at least one represented claim or evidence ID and rejects blank components', () => {
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
})
