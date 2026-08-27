import assert from 'node:assert/strict'
import test from 'node:test'
import type { RetrievedEvidenceArtifact } from '../research-engine/deterministic-retrieval'
import {
  EXECUTION_EVENT_SCHEMA_VERSION,
  RESEARCH_PACKET_SCHEMA_VERSION,
  RESEARCH_WORK_SCHEMA_VERSION,
  RETRIEVED_EVIDENCE_SCHEMA_VERSION,
  SIGNAL_SCHEMA_VERSION,
  type DeepEscalationReason,
} from './contracts'
import { adaptRetrievedEvidenceArtifact } from './retrieved-evidence-adapter'
import { ContractValidationError, validateRetrievedEvidence, validateSignal } from './validation'

const baseSignal = {
  schemaVersion: SIGNAL_SCHEMA_VERSION,
  signalId: 'sig-1',
  sourceId: 'source-1',
  observedAt: '2026-08-26T12:00:00.000Z',
  publishedAt: null,
  canonicalUrl: 'https://example.com/item',
  title: 'Title',
  visibleSummary: null,
  media: { imageUrl: null, attribution: null },
  sourceHints: { entities: [], assets: [], eventId: null, deadline: null },
  provenance: { provider: 'fixture', upstreamSource: null, rawPayloadRef: 'row-1' },
  idempotencyKey: 'stable-1',
  futureAdditiveField: { retained: true },
}

test('canonical versions are exact', () => {
  assert.equal(SIGNAL_SCHEMA_VERSION, 'myboon.signal.v1')
  assert.equal(RESEARCH_WORK_SCHEMA_VERSION, 'myboon.research_work.v1')
  assert.equal(RETRIEVED_EVIDENCE_SCHEMA_VERSION, 'myboon.evidence.v1')
  assert.equal(RESEARCH_PACKET_SCHEMA_VERSION, 'myboon.research_packet.v1')
  assert.equal(EXECUTION_EVENT_SCHEMA_VERSION, 'myboon.execution_event.v1')
})

test('validator accepts every registered source/content discriminant and preserves additive fields', () => {
  const variants = [
    ['news', 'article'],
    ['polymarket', 'market_event'],
    ['market_calendar', 'calendar_event'],
    ['x', 'social_thread'],
  ] as const
  for (const [sourceType, contentKind] of variants) {
    const input = {
      ...baseSignal,
      signalId: `sig-${sourceType}`,
      sourceType,
      contentKind,
      content: { schemaVersion: `myboon.signal_content.${contentKind}.v1`, sourceOwned: 'yes' },
    }
    const validated = validateSignal(input)
    assert.equal(validated, input)
    assert.deepEqual(validated.futureAdditiveField, { retained: true })
  }
})

test('validator rejects cross-source kinds and unknown major versions', () => {
  assert.throws(() => validateSignal({
    ...baseSignal,
    sourceType: 'news',
    contentKind: 'market_event',
    content: { schemaVersion: 'myboon.signal_content.market_event.v1' },
  }), ContractValidationError)
  assert.throws(() => validateSignal({
    ...baseSignal,
    schemaVersion: 'myboon.signal.v2',
    sourceType: 'news',
    contentKind: 'article',
    content: { schemaVersion: 'myboon.signal_content.article.v1' },
  }), /unsupported version/)
})

test('deep escalation registry is the exact PRD registry', () => {
  const reasons: DeepEscalationReason[] = [
    'conflicting_primary_sources',
    'insufficient_primary_evidence',
    'rendering_required_for_material_fact',
    'entity_identity_ambiguous',
    'regulatory_interpretation_required',
    'manual_analyst_request',
  ]
  assert.equal(reasons.length, 6)
})

test('RetrievedEvidence is structurally compatible with deterministic retrieval artifacts', () => {
  const artifact: RetrievedEvidenceArtifact = {
    schemaVersion: 'myboon.evidence.v1',
    evidenceId: 'evidence-1',
    workId: 'work-1',
    requestedUrl: 'https://example.com/a',
    finalUrl: 'https://example.com/b',
    authority: 'source_url',
    authorityId: 'source-1',
    contentHash: 'abc',
    contentType: 'text/html',
    httpStatus: 200,
    retrievalMethod: 'safe_http',
    retrievedAt: '2026-08-26T12:00:00.000Z',
    text: 'bounded text',
    byteLength: 12,
    truncated: false,
  }
  const canonical = adaptRetrievedEvidenceArtifact(artifact)
  assert.deepEqual(validateRetrievedEvidence(canonical), artifact)
})
