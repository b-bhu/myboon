import { compactString } from './normalization'
import type { ResearchPacket } from './types'

export interface PolymarketResearchRow {
  id: string
  candidate_id: string
  source: string
  area: string
  slug: string
  title: string
  candidate_type: string
  research_mode: string
  summary: string
  notes: string
  key_findings: unknown
  evidence_links: unknown
  uncertainty: string
  editor_notes: string
  researched_at: string
  research_family_key?: string | null
  research_cluster_key?: string | null
  research_depth?: string | null
  evidence_quality?: string | null
  catalyst_found?: boolean | null
  recommended_editor_action?: string | null
  research_backend?: string | null
  research_model?: string | null
  entity_manager_attempt_count?: number
}

export interface PolymarketCandidateContext {
  id: string
  market_id?: string | null
  slug: string
  title: string
  tag_slug?: string | null
  tag_label?: string | null
  observed_at?: string | null
  what_changed?: string | null
  why_flagged?: string | null
  score?: unknown
  score_breakdown?: unknown
  metrics?: unknown
  evidence_refs?: unknown
}

function arrayOrEmpty(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function evidenceUrl(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  return compactString(record.url ?? record.source_url) || null
}

function firstEvidenceUrl(...groups: unknown[][]): string | null {
  for (const item of groups.flat()) {
    const url = evidenceUrl(item)
    if (url) return url
  }
  return null
}

function numberField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key]
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(parsed) ? parsed : null
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, '')
}

function neutralResearchSummary(row: PolymarketResearchRow, candidate: PolymarketCandidateContext | null | undefined, metrics: Record<string, unknown>): string {
  const currentVolume = numberField(metrics, 'currentVolume')
  const previousVolume = numberField(metrics, 'previousVolume')
  const volumeDeltaPct = numberField(metrics, 'volumeDeltaPct')
  const volumeText = currentVolume !== null && previousVolume !== null
    ? ` Volume moved from ${formatNumber(previousVolume)} to ${formatNumber(currentVolume)}${volumeDeltaPct !== null ? ` (${formatNumber(volumeDeltaPct * 100)}%)` : ''}.`
    : ''
  const observedAt = candidate?.observed_at || row.researched_at
  return [
    `Research packet for Polymarket market "${row.title}".`,
    observedAt ? `Observed at ${observedAt}.` : '',
    volumeText.trim(),
  ].filter(Boolean).join(' ')
}

export function polymarketResearchToPacket(
  row: PolymarketResearchRow,
  candidate?: PolymarketCandidateContext | null
): ResearchPacket {
  const evidenceLinks = arrayOrEmpty(row.evidence_links)
  const candidateEvidence = arrayOrEmpty(candidate?.evidence_refs)
  const observedAt = row.researched_at || candidate?.observed_at || new Date(0).toISOString()
  const eventAt = candidate?.observed_at || row.researched_at || observedAt
  const metrics = recordOrEmpty(candidate?.metrics)
  const researchSummary = neutralResearchSummary(row, candidate, metrics)

  return {
    id: `polymarket:markets:${row.id}`,
    source: row.source || 'polymarket',
    sourceArea: row.area || 'markets',
    sourceResearchId: row.id,
    sourceType: 'market_signal',
    sourceRefId: row.slug || candidate?.slug || row.id,
    title: row.title,
    summary: researchSummary,
    body: [
      researchSummary,
      candidate?.what_changed ? `Collector observation: ${candidate.what_changed}` : '',
    ].filter(Boolean).join('\n\n'),
    observedAt,
    eventAt,
    url: firstEvidenceUrl(evidenceLinks, candidateEvidence),
    evidence: [...evidenceLinks, ...candidateEvidence],
    metrics,
    context: {
      source: 'polymarket_market_candidate_research',
      candidate_id: row.candidate_id,
      candidate_type: row.candidate_type,
      research_mode: row.research_mode,
      research_summary: researchSummary,
      evidence_link_count: evidenceLinks.length,
      candidate_evidence_count: candidateEvidence.length,
      research_family_key: row.research_family_key ?? null,
      research_cluster_key: row.research_cluster_key ?? null,
      research_depth: row.research_depth ?? null,
      research_backend: row.research_backend ?? null,
      research_model: row.research_model ?? null,
      entity_manager_attempt_count: row.entity_manager_attempt_count ?? 0,
      candidate: candidate ? {
        id: candidate.id,
        market_id: candidate.market_id ?? null,
        slug: candidate.slug,
        title: candidate.title,
        tag_slug: candidate.tag_slug ?? null,
        tag_label: candidate.tag_label ?? null,
        observed_at: candidate.observed_at ?? null,
        what_changed: candidate.what_changed ?? null,
        metrics: candidate.metrics ?? null,
      } : null,
      source_object: {
        type: 'polymarket_market',
        slug: row.slug,
        title: row.title,
        url: `https://polymarket.com/market/${row.slug}`,
      },
    },
  }
}
