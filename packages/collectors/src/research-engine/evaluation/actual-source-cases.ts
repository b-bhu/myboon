import { createHash } from 'node:crypto'
import type { GateEntityContext } from '../../research-gate/types'
import type { LiveResearchCase } from './live-evaluation'

interface HostedMemory {
  caseId?: string; memoryId: string; entityId: string; source: 'news' | 'polymarket'; sourceRefId: string
  title: string; summary: string | null; body: string | null; observedAt: string; eventAt: string | null
  memoryType: string; bodyTruncated?: boolean; evidenceTruncated?: boolean
}
interface HostedExport {
  schemaVersion: string; capturedAt: string; cases: HostedMemory[]; legacyContext: HostedMemory[]
  entities: Array<{ id: string; name: string; slug: string; summary: string | null }>
}
interface SourceExport {
  schemaVersion: string; snapshotCapturedAt: string
  cases: Array<{ caseId: string; sourceType: 'news' | 'polymarket'; title: string; body: string; observedAt: string
    nativePayloadReference: unknown; sourceSignalId: string; evidenceCapturedAt: string
    signal: { visibleSummary: string }; entityLabels: string[]
    capturedEvidence: Array<{ evidenceId: string; finalUrl?: string | null }>
    coverage: { fullArticleCompletenessVerified: boolean; exportTruncated: boolean; upstreamCaptureTruncated: boolean }
    retainedResearch: { openQuestions: Array<{ question?: string; reason?: string } | string>; completion: string
      claims: Array<{ text?: string; statement?: string; claim?: string }>; limitations: unknown[] }
  }>
}
interface ReviewerExport {
  schemaVersion: string; reviewer: unknown; cases: Array<{ caseId: string; category: string; expectation: string
    expectedEntityNames: string[]; forbiddenEntityIds?: string[]; resolvedSourceEntityId?: string }>
}
const textDigest = (value: string) => createHash('sha256').update(value).digest('hex')
const bounded = (value: string | null | undefined, limit: number) => (value ?? '').slice(0, limit)

/** Converts immutable exports into bounded judgments; never upgrades their source coverage. */
export function actualSourceEvaluationCases(hosted: HostedExport, source: SourceExport, reviewed: ReviewerExport): LiveResearchCase[] {
  if (hosted.schemaVersion !== 'myboon.v4_live_database_cases.v1'
    || source.schemaVersion !== 'myboon.entity_v4_actual_source_cases.v1'
    || !Array.isArray(reviewed.cases)) throw new Error('Actual evaluation requires the named source/reviewer export contracts')
  const cases: LiveResearchCase[] = []
  const reviewer = 'manual source reviewer; labels retained separately from model input'
  for (const row of hosted.cases) {
    const review = reviewed.cases.find((item) => item.caseId === row.caseId)
    if (!row.caseId || !review) throw new Error('Every selected hosted record requires its separate coverage review')
    const entity = hosted.entities.find((item) => item.id === row.entityId)
    if (!entity) throw new Error('Hosted case lost its exact entity catalogue row')
    const memories = hosted.legacyContext.filter((item) => item.entityId === row.entityId).slice(0, 2)
    const context: GateEntityContext = { entities: [{ ...entity, summary: entity.summary?.slice(0, 1_000) ?? null }],
      recentMemories: memories.map((memory) => ({ entityId: memory.entityId, memoryType: memory.memoryType,
        title: bounded(memory.title, 500), summary: bounded(memory.body || memory.summary, 2_000),
        eventAt: memory.eventAt || memory.observedAt })) }
    const material = bounded(row.body || row.summary, 12_000)
    const base: LiveResearchCase = { id: `${row.caseId}:natural-novelty`, source: row.source, workload: 'novelty', label: null,
      rationale: `Observational legacy excerpt. Coverage reviewer: ${review.category}; ${review.expectation}`,
      state: { signal: { source: row.source, sourceRefId: row.sourceRefId, title: bounded(row.title, 500),
        whatChanged: bounded(row.summary || row.title, 2_000), observedAt: row.observedAt, sourceMaterial: material,
        sourceMaterialDigest: textDigest(material), sourceMaterialComplete: false }, context },
      coverage: { completeSource: false, completeLookup: false, itemRefs: memories.map((memory) => memory.memoryId),
        failures: ['Legacy memory excerpt is not a complete captured source; historical comparison is a bounded selection.',
          ...(review.category === 'catalog_identity_pollution' ? ['Stored entity membership is polluted and cannot prove relevant context.'] : [])] },
      origin: { kind: 'actual_source', sourceRef: row.sourceRefId, capturedAt: hosted.capturedAt, reviewer } }
    cases.push(base)
    // A byte-identical source excerpt is a semantic duplicate, but cannot prove full-source skip eligibility.
    if (review.category === 'useful_attributed_partial' || review.category === 'useful_source_attributed_market_observation') {
      cases.push({ ...base, id: `${row.caseId}:duplicate-excerpt`, label: 'already_known',
        rationale: 'Reviewed deterministic transform: the identical attributed excerpt is the entire supplied comparison note. No claim of complete original article or external truth.',
        state: { ...base.state, context: { ...context, recentMemories: [{ entityId: row.entityId,
          memoryType: row.memoryType, title: bounded(row.title, 500), summary: material.slice(0, 2_000),
          eventAt: row.eventAt || row.observedAt }] } },
        origin: { ...base.origin!, kind: 'actual_source_transform' } })
    }
    if (review.category === 'catalog_identity_pollution') {
      const unrelated = memories.filter((memory) => !/solana|\bSOL\b/i.test(`${memory.title} ${memory.summary} ${memory.body}`))
      cases.push({ ...base, id: `${row.caseId}:unrelated-gpt-history`, label: 'new_information',
        rationale: 'Reviewed transform: source-grounded Solana excerpt compared only with GPT-5.6 history; topic aliases do not establish knowledge of the Solana assertion.',
        state: { ...base.state, context: { ...context, recentMemories: unrelated.length ? unrelated.map((memory) => ({ entityId: memory.entityId,
          memoryType: memory.memoryType, title: bounded(memory.title, 500), summary: bounded(memory.body || memory.summary, 2_000),
          eventAt: memory.eventAt || memory.observedAt })) : [{ entityId: entity.id,
          memoryType: 'evaluation_catalogue_summary', title: entity.name,
          summary: bounded(entity.summary, 2_000), eventAt: row.observedAt }] } },
        origin: { ...base.origin!, kind: 'actual_source_transform' } })
    }
    if (review.category === 'contradictory_evidence_partial') {
      const comparison = 'Kitco reports gold all-time high $5,589.38/oz on January 28, 2026.'
      const conflicting = 'TradingView reports gold all-time high $5,602.225 on January 29, 2026. The disagreement with Kitco remains unresolved; neither attributed value is independently verified.'
      cases.push({ ...base, id: `${row.caseId}:conflicting-attributed-values`, label: 'contradicts_prior',
        rationale: 'Manual deterministic excerpt selection from the saved disagreement. Opposed reported ATH values are conflicting assertions, not resolved external truth.',
        state: { signal: { ...base.state.signal, whatChanged: conflicting, sourceMaterial: conflicting,
          sourceMaterialDigest: textDigest(conflicting) }, context: { ...context, recentMemories: [{ entityId: row.entityId,
            memoryType: row.memoryType, title: 'Previously attributed Kitco observation', summary: comparison,
            eventAt: row.eventAt || row.observedAt }] } }, origin: { ...base.origin!, kind: 'actual_source_transform' } })
    }
  }
  for (const row of source.cases) {
    const material = bounded(row.body, 12_000)
    const exactEntities = hosted.entities.filter((entity) => row.entityLabels.some((label) => label.toLocaleLowerCase() === entity.name.toLocaleLowerCase()))
    const memories = hosted.legacyContext.filter((memory) => exactEntities.some((entity) => entity.id === memory.entityId)).slice(0, 4)
    const context: GateEntityContext = { entities: exactEntities.map((entity) => ({ ...entity, summary: entity.summary?.slice(0, 1_000) ?? null })),
      recentMemories: memories.map((memory) => ({ entityId: memory.entityId, memoryType: memory.memoryType,
        title: bounded(memory.title, 500), summary: bounded(memory.body || memory.summary, 2_000), eventAt: memory.eventAt || memory.observedAt })) }
    const full = row.coverage.fullArticleCompletenessVerified && !row.coverage.upstreamCaptureTruncated
      && !row.coverage.exportTruncated && row.body.length <= 12_000
    const base: LiveResearchCase = { id: `captured:${row.caseId}:natural-novelty`, source: row.sourceType, workload: 'novelty', label: null,
      rationale: 'Unlabeled captured public source and bounded exact-name historical context. Original dates, clipping and unverified full-source completeness are retained.',
      state: { signal: { source: row.sourceType, sourceRefId: row.sourceSignalId, title: bounded(row.title, 500),
        whatChanged: bounded(row.signal.visibleSummary || row.title, 2_000), observedAt: row.observedAt,
        sourceMaterial: material, sourceMaterialDigest: textDigest(material), sourceMaterialComplete: full }, context },
      coverage: { completeSource: full, completeLookup: false, itemRefs: memories.map((memory) => memory.memoryId),
        failures: ['Historical context was selected from an exported subset; completeness and current managed history are unproved.',
          ...(!full ? ['Complete original article/source coverage is unproved.'] : [])] },
      origin: { kind: 'actual_source', sourceRef: row.sourceSignalId, capturedAt: row.evidenceCapturedAt, reviewer } }
    cases.push(base)
    const assignment = `Source observation: ${row.title}. Existing Research completion: ${row.retainedResearch.completion}.`
    const questions = JSON.stringify(row.retainedResearch.openQuestions).slice(0, 2_000)
    const boundedEvidence = row.capturedEvidence.map((evidence) => ({ evidenceId: evidence.evidenceId, url: evidence.finalUrl }))
    const followupMaterial = `${assignment}\nRetained body excerpt:\n${material.slice(0, 7_000)}\nOpen questions:\n${questions}\nPreviously captured evidence (not a new admitted follow-up URL):\n${JSON.stringify(boundedEvidence)}\nNo additional retrieval admission or current freshness proof has been supplied.`.slice(0, 12_000)
    cases.push({ ...base, id: `captured:${row.caseId}:natural-followup`, workload: 'followup',
      rationale: 'Observational follow-up value on the real retained packet; no extra paid investigation is dispatched by this evaluation.',
      state: { signal: { ...base.state.signal, whatChanged: assignment.slice(0, 2_000), sourceMaterial: followupMaterial,
        sourceMaterialDigest: textDigest(followupMaterial), sourceMaterialComplete: false }, context },
      coverage: { ...base.coverage, completeSource: false } })
  }
  return cases
}
