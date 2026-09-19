import { firstEvidenceUrl, sourceLabelFromUrl } from './notifier'
import type { XDeskRunResult, XDeskStoredCandidate } from './types'

export const DEFAULT_X_DESK_SUGGESTION_COUNT = 5
export const MAX_X_DESK_SUGGESTION_COUNT = 5

export interface XDeskOnDemandResponse {
  schemaVersion: 'myboon.x_desk_on_demand.v1'
  mode: 'on_demand'
  requested: number
  returned: number
  lookbackStart: string
  run: XDeskRunResult
  suggestions: Array<{
    candidateId: string
    entity: string
    postText: string
    source: string
    sourceTitle: string
    sourceMemoryId: string
    eventAt: string | null
    changedAt: string
    rationale: string | null
    confidence: number | null
  }>
  publication: 'human_review_only'
}

export function requestedSuggestionCount(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_X_DESK_SUGGESTION_COUNT
  if (!/^\d+$/.test(raw)) throw new Error('Suggestion count must be an integer from 1 to 5.')
  const value = Number(raw)
  if (value < 1 || value > MAX_X_DESK_SUGGESTION_COUNT) {
    throw new Error('Suggestion count must be an integer from 1 to 5.')
  }
  return value
}

function sourceUrl(candidate: XDeskStoredCandidate): string | null {
  const evidenceUrl = firstEvidenceUrl(candidate.memory.evidence)
  if (evidenceUrl) return evidenceUrl
  const ref = candidate.memory.provenance.sourceRefId
  return /^https?:\/\//i.test(ref) ? ref : null
}

export function buildOnDemandResponse(input: {
  requested: number
  lookbackStart: string
  run: XDeskRunResult
  candidates: XDeskStoredCandidate[]
}): XDeskOnDemandResponse {
  const suggestions = input.candidates.slice(0, input.requested).flatMap((candidate) => {
    if (!candidate.postText) return []
    return [{
      candidateId: candidate.id,
      entity: candidate.entityName ?? candidate.entitySlug ?? candidate.entityId,
      postText: candidate.postText,
      source: sourceLabelFromUrl(sourceUrl(candidate)),
      sourceTitle: candidate.memory.title,
      sourceMemoryId: candidate.memoryId,
      eventAt: candidate.memory.eventAt,
      changedAt: candidate.changedAt,
      rationale: candidate.rationale,
      confidence: candidate.confidence,
    }]
  })

  return {
    schemaVersion: 'myboon.x_desk_on_demand.v1',
    mode: 'on_demand',
    requested: input.requested,
    returned: suggestions.length,
    lookbackStart: input.lookbackStart,
    run: input.run,
    suggestions,
    publication: 'human_review_only',
  }
}
