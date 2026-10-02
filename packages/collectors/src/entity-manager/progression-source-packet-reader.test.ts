import assert from 'node:assert/strict'
import test from 'node:test'
import type { ResearchPacketV1 } from '../signal-platform/contracts'
import {
  ProgressionSourcePacketEvidenceReader,
  progressionSourcePacketDigest,
} from './progression-source-packet-reader'

function packet(): ResearchPacketV1 {
  return {
    schemaVersion: 'myboon.research_packet.v1',
    packetId: 'packet-source-reader',
    workId: 'work-source-reader',
    signalId: 'signal-source-reader',
    sourceType: 'news',
    observedAt: '2026-09-11T00:00:00.000Z',
    sourceSignal: {
      title: 'A source-backed finding',
      canonicalUrl: 'https://example.com/story',
      publishedAt: '2026-09-11T00:00:00.000Z',
      provenance: { provider: 'fixture', upstreamSource: 'Fixture', rawPayloadRef: 'fixture-1' },
    },
    claims: [{ claimId: 'claim-1', claim: 'A supported claim.', attributedTo: null, evidenceRefs: ['evidence-1'] }],
    verifiedFacts: [],
    unresolvedClaims: [],
    evidence: [{
      evidenceId: 'evidence-1', title: 'Source document', url: 'https://example.com/source',
      sourceType: 'news', observedAt: '2026-09-11T00:00:00.000Z', note: null,
    }],
    entityHints: [],
    limitations: [],
    openQuestions: [],
    completion: 'complete',
    budgetUsed: {
      providerCalls: 0, repairCalls: 0, inputTokens: 0, outputTokens: 0,
      toolCalls: 0, wallTimeMs: 0, budgetExceeded: false,
    },
    execution: {
      provider: 'fixture', model: 'fixture', fallbackProvider: null, fallbackModel: null,
      fallbackUsed: false, promptVersion: 'fixture-v1', policyVersion: 'fixture-v1',
      traceId: 'trace-source-reader', attempt: 1,
    },
    researchContractVersion: 'myboon.research_packet.v1',
    createdAt: '2026-09-11T00:00:00.000Z',
  }
}

test('reader loads the code-owned saved packet and derives evidence tuples from its claim graph', async () => {
  const saved = packet()
  const readWorkIds: string[] = []
  const reader = new ProgressionSourcePacketEvidenceReader({
    readResearchPacket: async (workId) => { readWorkIds.push(workId); return saved },
  })

  const result = await reader.loadSavedPacket({
    workId: saved.workId,
    packetDigest: progressionSourcePacketDigest(saved),
  })

  assert.deepEqual(readWorkIds, [saved.workId])
  assert.deepEqual(result, {
    workId: saved.workId,
    packetDigest: progressionSourcePacketDigest(saved),
    evidenceRefs: [{ claimId: 'claim-1', evidenceId: 'evidence-1', sourceRef: 'https://example.com/source' }],
  })
})

test('reader fails closed on work or full-packet digest mismatch', async () => {
  const saved = packet()
  const sourceSignal = { ...saved.sourceSignal, title: 'Changed after the saved digest was recorded' }
  const changedPacket = { ...saved, sourceSignal }
  const reader = new ProgressionSourcePacketEvidenceReader({ readResearchPacket: async () => changedPacket })

  assert.equal(await reader.loadSavedPacket({
    workId: 'different-work',
    packetDigest: progressionSourcePacketDigest(saved),
  }), null)
  assert.equal(await reader.loadSavedPacket({
    workId: saved.workId,
    packetDigest: progressionSourcePacketDigest(saved),
  }), null)
})

test('reader refuses malformed or dangling claim-to-evidence links', async () => {
  const saved = packet()
  const dangling = {
    ...saved,
    claims: [{ ...saved.claims[0]!, evidenceRefs: ['not-in-packet'] }],
  }
  const reader = new ProgressionSourcePacketEvidenceReader({ readResearchPacket: async () => dangling })

  assert.equal(await reader.loadSavedPacket({
    workId: saved.workId,
    packetDigest: progressionSourcePacketDigest(dangling),
  }), null)
})
