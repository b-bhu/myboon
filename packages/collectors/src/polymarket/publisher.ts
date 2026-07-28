import type { SupabaseClient } from '@supabase/supabase-js'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { PipelineCandidateRow, PipelineResearchRow, PipelineStore } from '../pipeline-store/store'

const execFileAsync = promisify(execFile)

const SOURCE = 'polymarket'
const AREA = 'markets'
const DEFAULT_PUBLISHER_TIMEOUT_MS = 10 * 60 * 1000

export interface PolymarketPublisherOptions {
  now?: string
  batchSize?: number
  recentPublishedLimit?: number
  backend?: 'cli_agent'
  publisherCommand?: string
  publisherToolsets?: string
  publisherTimeoutMs?: number
}

interface PendingPublisherDecision {
  id: string
  research_ids: string[]
  decision: 'publish'
  status: 'pending_publisher'
  angle: string | null
  why_this_matters: string | null
  reasoning: string
  reason_codes: string[]
  evidence_quality: 'strong' | 'medium' | 'weak'
  primary_topic: string | null
  related_topics: string[]
  publisher_notes: string | null
  created_at: string
}

interface ResearchRowForPublish {
  id: string
  candidate_id: string
  slug: string
  title: string
  candidate_type: string
  research_mode: string
  summary: string
  notes: string
  key_findings: unknown
  evidence_links: unknown
  uncertainty: string
}

interface CandidateLite {
  id: string
  slug: string
  title: string
  candidate_type: string
  what_changed: string
  why_flagged: string
  observed_at: string
  score: number | string
}

interface RecentPublished {
  id: string
  content_small: string
  tags: unknown
  content_type: string | null
  created_at: string
  source: string | null
  primary_topic: string | null
}

interface EditorialVoiceProfile {
  voice: string
  dialect: string
  lead_style: string
  sentence_style: string
  evidence_posture: string
  vocabulary: string[]
  avoid: string[]
}

interface AgentPublication {
  editor_decision_id?: unknown
  content_small?: unknown
  content_full?: unknown
  reasoning?: unknown
  tags?: unknown
  priority?: unknown
  actions?: unknown
  content_type?: unknown
}

interface AgentPublisherResponse {
  publications: AgentPublication[]
}

interface NormalizedPublication {
  editor_decision_id: string
  content_small: string
  content_full: string
  reasoning: string
  tags: string[]
  priority: number
  actions: Array<{ type: 'predict' | 'perps'; slug?: string; asset?: string }>
  content_type: 'fomo' | 'signal' | 'sports' | 'macro' | 'news' | 'crypto'
}

interface InsertedPublication {
  id: string
  editor_decision_id: string | null
}

export interface PolymarketPublisherResult {
  observedAt: string
  backend: string
  decisionsFetched: number
  publicationsWritten: number
  researchRowsPublished: number
  candidatesPublished: number
  publications: Array<{
    id: string
    editorDecisionId: string
    contentSmall: string
    tags: string[]
  }>
}

function envNumber(name: string, fallback: number): number {
  const parsed = Number(process.env[name])
  return Number.isFinite(parsed) ? parsed : fallback
}

function envString(name: string, fallback: string): string {
  const value = process.env[name]?.trim()
  return value ? value : fallback
}

function selectedBackend(partial?: 'cli_agent'): 'cli_agent' {
  const envBackend = process.env.POLYMARKET_PUBLISHER_BACKEND
  const backend = partial ?? envBackend ?? 'cli_agent'
  if (backend !== 'cli_agent') throw new Error(`Unsupported Polymarket publisher backend: ${backend}`)
  return backend
}

function selectedOptions(partial: PolymarketPublisherOptions): Required<PolymarketPublisherOptions> {
  return {
    now: partial.now ?? new Date().toISOString(),
    batchSize: partial.batchSize ?? envNumber('POLYMARKET_PUBLISHER_BATCH_SIZE', 10),
    recentPublishedLimit: partial.recentPublishedLimit ?? envNumber('POLYMARKET_PUBLISHER_RECENT_PUBLISHED_LIMIT', 40),
    backend: selectedBackend(partial.backend),
    publisherCommand: partial.publisherCommand ?? envString('POLYMARKET_PUBLISHER_COMMAND', 'hermes'),
    publisherToolsets: partial.publisherToolsets ?? envString('POLYMARKET_PUBLISHER_TOOLSETS', 'web'),
    publisherTimeoutMs: partial.publisherTimeoutMs ?? envNumber('POLYMARKET_PUBLISHER_TIMEOUT_MS', DEFAULT_PUBLISHER_TIMEOUT_MS),
  }
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asNullableString(value: unknown): string | null {
  const text = asString(value).trim()
  return text ? text : null
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => asString(item).trim())
    .filter(Boolean)
}

function normalizeContentType(value: unknown): 'fomo' | 'signal' | 'sports' | 'macro' | 'news' | 'crypto' {
  const normalized = asString(value).toLowerCase().trim()
  if (['fomo', 'signal', 'sports', 'macro', 'news', 'crypto'].includes(normalized)) {
    return normalized as any
  }
  return 'signal'
}

function normalizePriority(value: unknown): number {
  const n = Number(value)
  if (Number.isFinite(n)) {
    return Math.max(0, Math.min(100, Math.round(n)))
  }
  return 55
}

function clampText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  const clipped = value.slice(0, Math.max(0, maxLength - 3)).replace(/\s+\S*$/, '').trim()
  return `${clipped || value.slice(0, Math.max(0, maxLength - 3)).trim()}...`
}

function normalizeActions(value: unknown, allowedSlugs: Set<string>): Array<{ type: 'predict'; slug: string }> {
  if (!Array.isArray(value)) return []
  const out: Array<{ type: 'predict'; slug: string }> = []
  const seen = new Set<string>()
  for (const item of value) {
    if (item && typeof item === 'object') {
      const t = asString((item as any).type)
      const slug = asNullableString((item as any).slug)
      if (t === 'predict' && slug && allowedSlugs.has(slug) && !seen.has(slug)) {
        out.push({ type: 'predict', slug })
        seen.add(slug)
      }
    }
  }
  return out
}

function includesAny(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle))
}

function inferEditorialVoiceProfile(
  decision: PendingPublisherDecision,
  researches: ResearchRowForPublish[],
  candidates: CandidateLite[]
): EditorialVoiceProfile {
  const topicText = [
    SOURCE,
    AREA,
    decision.primary_topic,
    ...decision.related_topics,
    decision.angle,
    decision.why_this_matters,
    decision.publisher_notes,
    ...researches.flatMap((r) => [r.candidate_type, r.research_mode, r.title, r.summary]),
    ...candidates.flatMap((c) => [c.candidate_type, c.title, c.what_changed, c.why_flagged]),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  let voice = 'market intelligence editor'
  let dialect = 'cross-market signal brief'
  let leadStyle = 'Lead with the concrete signal, then name why it matters now.'
  let sentenceStyle = 'Plain, compressed, and specific; no personality performance.'
  let vocabulary = ['signal', 'evidence', 'market', 'context']

  if (includesAny(topicText, ['iran', 'geopolitic', 'war', 'peace', 'fed', 'rates', 'oil', 'gold', 'macro', 'election', 'tariff'])) {
    voice = 'macro desk editor'
    dialect = 'geopolitical and macro risk brief'
    leadStyle = 'Lead with the event-risk development and the market reaction.'
    vocabulary = ['talks', 'risk', 'timeline', 'market reaction', 'uncertainty']
  } else if (includesAny(topicText, ['btc', 'bitcoin', 'eth', 'ethereum', 'sol', 'solana', 'crypto', 'token', 'perp', 'funding', 'open interest'])) {
    voice = 'crypto markets editor'
    dialect = 'crypto trading desk brief'
    leadStyle = 'Lead with the asset or venue move, then explain the positioning or catalyst.'
    vocabulary = ['spot', 'perps', 'positioning', 'liquidity', 'catalyst']
  } else if (includesAny(topicText, ['wallet', 'holder', 'whale', 'onchain', 'transfer', 'deposit', 'withdraw'])) {
    voice = 'onchain tape editor'
    dialect = 'wallet and flow brief'
    leadStyle = 'Lead with the actor or flow change, then state what makes it worth watching.'
    vocabulary = ['wallet', 'flow', 'accumulation', 'distribution', 'venue']
  } else if (includesAny(topicText, ['acquir', 'merger', 'm&a', 'earnings', 'company', 'biotech', 'pharma', 'revenue', 'analyst'])) {
    voice = 'business catalyst editor'
    dialect = 'company and deal-flow brief'
    leadStyle = 'Lead with the corporate catalyst and the market-implied change.'
    vocabulary = ['catalyst', 'deal', 'coverage', 'timeline', 'confirmation']
  } else if (includesAny(topicText, ['sports', 'fifa', 'world cup', 'nba', 'nfl', 'match', 'team', 'tournament'])) {
    voice = 'sports markets editor'
    dialect = 'sports event-market brief'
    leadStyle = 'Lead with the event state or lineup change and the resulting market signal.'
    vocabulary = ['match', 'lineup', 'odds', 'schedule', 'market']
  }

  const avoid = [
    'Do not add hype, moralizing, or calls to action.',
    'Do not invent facts beyond the editor decision and linked research.',
  ]
  let evidencePosture = 'State evidence directly and preserve caveats.'
  if (decision.evidence_quality === 'strong') {
    evidencePosture = 'Write with confidence, but keep uncertainty explicit where research includes it.'
  } else if (decision.evidence_quality === 'weak') {
    evidencePosture = 'Use cautious language and frame this as an early or thin signal.'
    avoid.push('Do not make weak evidence sound confirmed.')
  } else {
    evidencePosture = 'Frame as useful but incomplete evidence; avoid overstating causality.'
  }

  return {
    voice,
    dialect,
    lead_style: leadStyle,
    sentence_style: sentenceStyle,
    evidence_posture: evidencePosture,
    vocabulary,
    avoid,
  }
}

function extractJson<T>(text: string): T | null {
  const cleaned = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
  try {
    return JSON.parse(cleaned) as T
  } catch {
    // Continue into fragment extraction.
  }

  const start = cleaned.search(/[{[]/)
  if (start === -1) return null
  const opener = cleaned[start]
  const closer = opener === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escape = false
  for (let index = start; index < cleaned.length; index += 1) {
    const ch = cleaned[index]
    if (escape) {
      escape = false
      continue
    }
    if (ch === '\\' && inString) {
      escape = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === opener) depth += 1
    else if (ch === closer) depth -= 1
    if (depth === 0) {
      try {
        return JSON.parse(cleaned.slice(start, index + 1)) as T
      } catch {
        return null
      }
    }
  }
  return null
}

async function fetchPendingPublisherDecisions(store: PipelineStore, batchSize: number): Promise<PendingPublisherDecision[]> {
  const rows = await store.findEditorDecisions({
    source: SOURCE,
    area: AREA,
    status: 'pending_publisher',
    decision: 'publish',
    orderBy: 'asc',
    limit: batchSize,
  })
  return rows.map((row) => ({
    id: row.id,
    research_ids: row.researchIds,
    decision: 'publish' as const,
    status: 'pending_publisher' as const,
    angle: row.angle,
    why_this_matters: row.whyThisMatters,
    reasoning: row.reasoning,
    reason_codes: asStringArray(row.reasonCodes),
    evidence_quality: row.evidenceQuality,
    primary_topic: row.primaryTopic,
    related_topics: asStringArray(row.relatedTopics),
    publisher_notes: row.publisherNotes,
    created_at: row.createdAt,
  }))
}

function toResearchRowForPublish(row: PipelineResearchRow): ResearchRowForPublish {
  return {
    id: row.id,
    candidate_id: row.candidateId,
    slug: row.slug,
    title: row.title,
    candidate_type: row.candidateType,
    research_mode: row.researchMode,
    summary: row.summary,
    notes: row.notes,
    key_findings: row.keyFindings,
    evidence_links: row.evidenceLinks,
    uncertainty: row.uncertainty,
  }
}

function toCandidateLite(row: PipelineCandidateRow): CandidateLite {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    candidate_type: row.candidateType,
    what_changed: row.whatChanged,
    why_flagged: row.whyFlagged,
    observed_at: row.observedAt,
    score: row.score,
  }
}

async function fetchRecentPublished(db: SupabaseClient, limit: number): Promise<RecentPublished[]> {
  const { data, error } = await db
    .from('published_narratives')
    .select('id, content_small, tags, content_type, created_at, source, primary_topic')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw new Error(`recent published fetch failed: ${error.message}`)
  return (data ?? []) as RecentPublished[]
}

async function loadStablePrompt(): Promise<string> {
  return readFile(join(__dirname, 'publisher-prompt.md'), 'utf8')
}

function buildPublisherPrompt(
  decisions: PendingPublisherDecision[],
  researchByDecision: Map<string, ResearchRowForPublish[]>,
  candidatesByResearch: Map<string, CandidateLite>,
  recentPublished: RecentPublished[]
): string {
  const payload = {
    pending_publish_decisions: decisions.map((d) => {
      const researches = researchByDecision.get(d.id) ?? []
      const cands = researches
        .map((r) => candidatesByResearch.get(r.candidate_id))
        .filter((c): c is CandidateLite => Boolean(c))
      return {
        editor_decision_id: d.id,
        angle: d.angle,
        why_this_matters: d.why_this_matters,
        editor_reasoning: d.reasoning,
        evidence_quality: d.evidence_quality,
        primary_topic: d.primary_topic,
        related_topics: d.related_topics,
        publisher_notes: d.publisher_notes,
        editorial_voice: inferEditorialVoiceProfile(d, researches, cands),
        created_at: d.created_at,
        linked_research: researches.map((r) => ({
          id: r.id,
          slug: r.slug,
          title: r.title,
          candidate_type: r.candidate_type,
          research_mode: r.research_mode,
          summary: r.summary,
          notes: r.notes,
          key_findings: r.key_findings,
          evidence_links: r.evidence_links,
          uncertainty: r.uncertainty,
        })),
        linked_candidates: cands.map((c) => ({
          id: c.id,
          slug: c.slug,
          title: c.title,
          candidate_type: c.candidate_type,
          what_changed: c.what_changed,
          why_flagged: c.why_flagged,
          observed_at: c.observed_at,
          score: c.score,
        })),
      }
    }),
    recent_published: recentPublished.map((p) => ({
      id: p.id,
      content_small: p.content_small,
      tags: p.tags,
      content_type: p.content_type,
      created_at: p.created_at,
      source: p.source,
      primary_topic: p.primary_topic,
    })),
  }

  return [
    '## Stable Instructions',
    '{{STABLE_PROMPT}}',
    '',
    '## Dynamic Publisher Batch',
    'Turn the following approved editor decisions + their research into final feed items.',
    'Return one publication per editor decision. Cover every editor_decision_id exactly once.',
    '',
    'Return strict JSON in this exact shape:',
    JSON.stringify({
      publications: [
        {
          editor_decision_id: 'editor decision uuid',
          content_small: 'tight headline sentence',
          content_full: '2-4 sentence detail',
          reasoning: 'what drove the wording',
          tags: ['crypto'],
          priority: 60,
          actions: [{ type: 'predict', slug: 'exact-slug' }],
          content_type: 'crypto',
        },
      ],
    }, null, 2),
    '',
    'Batch payload:',
    JSON.stringify(payload, null, 2),
  ].join('\n')
}

async function runPublisherAgent(prompt: string, options: Required<PolymarketPublisherOptions>): Promise<AgentPublisherResponse> {
  const stablePrompt = await loadStablePrompt()
  const fullPrompt = prompt.replace('{{STABLE_PROMPT}}', stablePrompt)
  const args = options.publisherToolsets
    ? ['-t', options.publisherToolsets, '-z', fullPrompt]
    : ['-z', fullPrompt]
  const { stdout, stderr } = await execFileAsync(
    options.publisherCommand,
    args,
    {
      timeout: options.publisherTimeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env },
    }
  )

  const parsed = extractJson<AgentPublisherResponse>(stdout)
  if (!parsed || !Array.isArray(parsed.publications)) {
    throw new Error(`Publisher returned invalid JSON. stderr=${stderr.slice(0, 500)} stdout=${stdout.slice(0, 1000)}`)
  }

  return parsed
}

function normalizePublication(
  pub: AgentPublication,
  validDecisionIds: Set<string>,
  linkedSlugs: Set<string>
): NormalizedPublication | null {
  const decisionId = asString(pub.editor_decision_id).trim()
  if (!decisionId || !validDecisionIds.has(decisionId)) return null

  const contentSmall = asString(pub.content_small).trim()
  const contentFull = asString(pub.content_full).trim()
  if (!contentSmall) return null
  const actions = normalizeActions(pub.actions, linkedSlugs)
  const coveredSlugs = new Set(actions.map((a) => a.slug))
  for (const slug of linkedSlugs) {
    if (!coveredSlugs.has(slug)) actions.push({ type: 'predict', slug })
  }

  return {
    editor_decision_id: decisionId,
    content_small: clampText(contentSmall, 140),
    content_full: contentFull || contentSmall,
    reasoning: asString(pub.reasoning).trim() || 'Published from editor-approved research brief.',
    tags: asStringArray(pub.tags),
    priority: normalizePriority(pub.priority),
    actions,
    content_type: normalizeContentType(pub.content_type),
  }
}

function synthesizeFallbackPublication(
  decision: PendingPublisherDecision,
  research: ResearchRowForPublish[],
  candidates: CandidateLite[]
): NormalizedPublication {
  const angle = decision.angle || decision.why_this_matters || 'Market signal observed'
  const firstSummary = research[0]?.summary || research[0]?.notes || ''
  const slugs = Array.from(new Set(research.map((r) => r.slug).concat(candidates.map((c) => c.slug))))
  const actions = slugs.map((slug) => ({ type: 'predict' as const, slug }))
  const topic = decision.primary_topic || (slugs[0] ? slugs[0].split('-')[0] : 'markets')

  const contentSmall = clampText(`${angle.replace(/\.$/, '')}.`, 140)

  const context = firstSummary ? ` ${firstSummary.slice(0, 220)}` : ''
  const contentFull = `${angle}. ${decision.evidence_quality === 'strong' ? 'Strong signals in the research.' : 'Evidence noted in research.'}${context}`.trim()

  return {
    editor_decision_id: decision.id,
    content_small: contentSmall,
    content_full: contentFull || contentSmall,
    reasoning: 'Synthesized fallback from editor angle and research summary (agent omitted this decision).',
    tags: decision.related_topics.length ? decision.related_topics : [topic.toLowerCase()],
    priority: decision.evidence_quality === 'strong' ? 70 : 55,
    actions,
    content_type: /crypto|btc|eth|sol/.test(topic.toLowerCase()) ? 'crypto' : 'macro',
  }
}

function ensureAllCovered(
  normalized: NormalizedPublication[],
  decisions: PendingPublisherDecision[],
  researchByDecision: Map<string, ResearchRowForPublish[]>,
  candidatesByResearch: Map<string, CandidateLite>
): NormalizedPublication[] {
  const covered = new Set(normalized.map((p) => p.editor_decision_id))
  const missing = decisions.filter((d) => !covered.has(d.id))

  const fallbacks = missing.map((d) => {
    const res = researchByDecision.get(d.id) ?? []
    const cands = res
      .map((r) => candidatesByResearch.get(r.candidate_id))
      .filter((c): c is CandidateLite => Boolean(c))
    return synthesizeFallbackPublication(d, res, cands)
  })

  return [...normalized, ...fallbacks]
}

async function insertPublishedNarratives(
  db: SupabaseClient,
  pubs: NormalizedPublication[],
  decisions: PendingPublisherDecision[],
  observedAt: string
): Promise<InsertedPublication[]> {
  if (pubs.length === 0) return []

  const decisionById = new Map(decisions.map((d) => [d.id, d]))

  const rows = pubs.map((pub) => {
    const dec = decisionById.get(pub.editor_decision_id)
    const base = {
      content_small: pub.content_small,
      content_full: pub.content_full,
      reasoning: pub.reasoning,
      tags: pub.tags,
      priority: pub.priority,
      actions: pub.actions,
      content_type: pub.content_type,
      created_at: observedAt,
    }
    const v3 = {
      ...base,
      source: SOURCE,
      area: AREA,
      editor_decision_id: pub.editor_decision_id,
      research_ids: dec ? dec.research_ids : [],
      primary_topic: dec?.primary_topic ?? null,
    }
    return v3
  })

  // Try with V3 columns first. editor_decision_id is unique, so a retry after
  // a crash or concurrent publisher run updates the same final feed row.
  let { data, error } = await db
    .from('published_narratives')
    .upsert(rows, { onConflict: 'editor_decision_id' })
    .select('id, editor_decision_id')

  if (error) {
    const text = error.message || ''
    if (/column|source|area|editor_decision_id|research_ids|primary_topic/i.test(text)) {
      // Fallback to legacy columns only
      const legacyRows = rows.map((r) => ({
        content_small: r.content_small,
        content_full: r.content_full,
        reasoning: r.reasoning,
        tags: r.tags,
        priority: r.priority,
        actions: r.actions,
        content_type: r.content_type,
        created_at: observedAt,
      }))
      const fallback = await db
        .from('published_narratives')
        .insert(legacyRows)
        .select('id')
      if (fallback.error) throw new Error(`published_narratives legacy insert failed: ${fallback.error.message}`)
      data = (fallback.data ?? []).map((row: any, index: number) => ({
        id: row.id,
        editor_decision_id: rows[index]?.editor_decision_id ?? null,
      }))
      error = null
    } else {
      throw new Error(`published_narratives insert failed: ${error.message}`)
    }
  }

  return (data ?? []).map((d: any) => ({
    id: d.id,
    editor_decision_id: d.editor_decision_id ?? null,
  })) as InsertedPublication[]
}

/**
 * Marks published state for a batch of publications in a small, fixed number
 * of store calls instead of one editor-decision UPDATE + one research UPDATE
 * per publication: all editor decision ids are batched into a single
 * setEditorDecisionStatus call, and all research ids into a single
 * setResearchStatus call.
 */
async function markPublished(
  store: PipelineStore,
  inserted: InsertedPublication[],
  decisions: PendingPublisherDecision[],
  researchByDecision: Map<string, ResearchRowForPublish[]>,
  observedAt: string
): Promise<{ researchCount: number; candidateCount: number }> {
  const decisionMap = new Map(decisions.map((d) => [d.id, d]))

  const publishedDecisionIds = inserted
    .map((ins) => ins.editor_decision_id)
    .filter((id): id is string => Boolean(id))

  if (publishedDecisionIds.length > 0) {
    await store.setEditorDecisionStatus(publishedDecisionIds, 'published', observedAt)
  }

  const allResearchIds: string[] = []
  const allCandidateIds = new Set<string>()
  for (const decId of publishedDecisionIds) {
    const dec = decisionMap.get(decId)
    const resIds = dec?.research_ids ?? []
    allResearchIds.push(...resIds)
    for (const r of researchByDecision.get(decId) ?? []) {
      allCandidateIds.add(r.candidate_id)
    }
  }

  if (allResearchIds.length > 0) {
    await store.setResearchStatus(allResearchIds, 'published', observedAt)
  }
  if (allCandidateIds.size > 0) {
    await store.setCandidateStatus({
      ids: Array.from(allCandidateIds),
      status: 'published',
      observedAt,
    })
  }

  return { researchCount: allResearchIds.length, candidateCount: allCandidateIds.size }
}

export async function runPolymarketPublisher(
  store: PipelineStore,
  db: SupabaseClient,
  partialOptions: PolymarketPublisherOptions = {}
): Promise<PolymarketPublisherResult> {
  const options = selectedOptions(partialOptions)
  const observedAt = options.now

  const decisions = await fetchPendingPublisherDecisions(store, options.batchSize)
  if (decisions.length === 0) {
    return {
      observedAt,
      backend: options.backend,
      decisionsFetched: 0,
      publicationsWritten: 0,
      researchRowsPublished: 0,
      candidatesPublished: 0,
      publications: [],
    }
  }

  let inserted: InsertedPublication[] = []
  let normalizedPubs: NormalizedPublication[] = []

  try {
    const allResearchIds = Array.from(new Set(decisions.flatMap((d) => d.research_ids)))
    const allResearchRows = await store.getResearchByIds(allResearchIds)
    const allResearches = allResearchRows.map(toResearchRowForPublish)
    const researchByDecision = new Map<string, ResearchRowForPublish[]>()
    for (const d of decisions) {
      researchByDecision.set(
        d.id,
        allResearches.filter((r) => d.research_ids.includes(r.id))
      )
    }

    const allCandidateIds = Array.from(new Set(allResearchRows.map((r) => r.candidateId)))
    const candidateRows = await store.getCandidatesByIds(allCandidateIds)
    const candidates = candidateRows.map(toCandidateLite)
    const candidatesByResearch = new Map<string, CandidateLite>()
    for (const r of allResearchRows) {
      const candidate = candidates.find((c) => c.id === r.candidateId)
      if (candidate) candidatesByResearch.set(r.id, candidate)
    }

    const recent = await fetchRecentPublished(db, options.recentPublishedLimit)

    const prompt = buildPublisherPrompt(decisions, researchByDecision, candidatesByResearch, recent)
    const response = await runPublisherAgent(prompt, options)

    const validDecisionIds = new Set(decisions.map((d) => d.id))
    const linkedSlugsByDecision = new Map<string, Set<string>>()
    for (const d of decisions) {
      const linkedSlugs = new Set(
        (researchByDecision.get(d.id) ?? [])
          .map((r) => r.slug)
          .filter(Boolean)
      )
      linkedSlugsByDecision.set(d.id, linkedSlugs)
    }

    const normalized = response.publications
      .map((p) => {
        const decisionId = asString(p.editor_decision_id).trim()
        return normalizePublication(p, validDecisionIds, linkedSlugsByDecision.get(decisionId) ?? new Set())
      })
      .filter((p): p is NormalizedPublication => Boolean(p))

    normalizedPubs = ensureAllCovered(normalized, decisions, researchByDecision, candidatesByResearch)

    inserted = await insertPublishedNarratives(db, normalizedPubs, decisions, observedAt)

    // Update statuses
    const { researchCount, candidateCount } = await markPublished(
      store,
      inserted,
      decisions,
      researchByDecision,
      observedAt
    )

    return {
      observedAt,
      backend: options.backend,
      decisionsFetched: decisions.length,
      publicationsWritten: inserted.length,
      researchRowsPublished: researchCount,
      candidatesPublished: candidateCount,
      publications: inserted.map((ins) => {
        // Map explicitly by editor_decision_id instead of relying on array
        // index: the DB upsert can reorder or partially fail rows, so index
        // alignment between `inserted` and `normalizedPubs` is not guaranteed.
        const pub = normalizedPubs.find((p) => p.editor_decision_id === ins.editor_decision_id)
        return {
          id: ins.id,
          editorDecisionId: ins.editor_decision_id || '',
          contentSmall: pub ? pub.content_small : '',
          tags: pub ? pub.tags : [],
        }
      }),
    }
  } catch (error) {
    // On failure, do not leave in bad state — decisions remain pending_publisher
    throw error
  }
}
