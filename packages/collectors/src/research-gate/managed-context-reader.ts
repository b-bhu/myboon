import type { ManagedArticleContext } from '../entity-manager/postgres-knowledge-writer'
import { createHash } from 'node:crypto'
import type { EntityMemoryReader, GateEntity, GateMemory, GateNoveltyEvidence } from './types'
import { rankEntityCandidates } from './entity-candidates'
import { articleCandidateDecisionSummary } from '../research-engine/article-input-bounds'

/** Internal Research context only; this is not a downstream reader API. */
export interface ManagedResearchContextPort {
  researchContext(input: {
    source: string
    sourceRefs: readonly string[]
    labels?: readonly string[]
    entityIds?: readonly string[]
    itemIds?: readonly string[]
    limit?: number
  }): Promise<{
    entities: Array<{
      id: string, slug: string, name: string, summary: string | null,
      type?: string, aliases?: string[], metadata?: Record<string, unknown>,
    }>
    items: Array<{
      itemId: string, entityIds: string[], note: string, status: string,
      revision: string | number, observedAt: string, packetRefs: string[], evidenceRefs: unknown[],
    }>
    digest: string
    watermark: string | number | null
    truncated: boolean
  }>
  /** Optional richer managed article lookup retaining legacy/managed origin. */
  articleContext?(input: {
    source: string
    sourceRefs: readonly string[]
    labels?: readonly string[]
    entityIds?: readonly string[]
    itemIds?: readonly string[]
    limit?: number
    /** Recent reads ignore source/term filters; targeted reads use them for dedup. */
    historyMode?: 'recent' | 'targeted'
    identityOnly?: boolean
  }): Promise<{
    entities: Array<{
      id: string, slug: string, name: string, summary: string | null,
      type?: string, aliases?: string[], metadata?: Record<string, unknown>,
    }>
    items: Array<{
      itemId: string, entityIds: string[], note: string, status: string,
      revision: string | number, observedAt: string, packetRefs: string[], evidenceRefs: unknown[],
    }>
    articleItems?: Array<{
      itemId: string, entityId: string, origin: 'legacy' | 'managed', title: string, summary: string, observedAt: string,
      eventAt?: string | null, publishedAt?: string | null,
    }>
    digest: string
    watermark: string | number | null
    truncated: boolean
    candidateTruncated?: boolean
  }>
}

export type ArticleContextCoverageKind = 'transient' | 'permanent'

/**
 * Context lookups are normally converted into bounded coverage failures. Keep
 * the storage availability signal alongside the redacted message so article
 * placement can wait for an outage without treating identity ambiguity as a
 * retryable provider result.
 */
export function isTransientContextFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const value = error as { code?: unknown, status?: unknown, message?: unknown }
  const code = typeof value.code === 'string' ? value.code.toUpperCase() : ''
  const status = typeof value.status === 'number' ? value.status : null
  const message = typeof value.message === 'string' ? value.message : String(error)
  return /^PGRST00[0-3]$/.test(code)
    || /^ECONN[A-Z0-9_]+$/i.test(code)
    || /^(?:ETIMEDOUT|ETIMEOUT|EHOSTUNREACH|EPIPE|ENET(?:DOWN|UNREACH)|SQLSTATE:?(?:57014|55P03|53300|57P0[13])|57014|55P03|53300|57P0[13])$/i.test(code)
    || (status !== null && [408, 429, 500, 502, 503, 504].includes(status))
    || /PGRST00[0-3]|could not query the database for the schema cache\.\s*retrying|connection (?:terminated|closed|timed out|timeout|refused|reset)|(?:socket hang up|fetch failed|network error|server closed the connection|request aborted)|(?:operation|request).*aborted.*timeout|(?:request|query|socket|network|database).*(?:timed out|timeout|unavailable)|timed out|ECONN[A-Z0-9_]+|E(?:TIMEDOUT|TIMEOUT|HOSTUNREACH|PIPE)|SQLSTATE:?(?:57014|55P03|53300|57P0[13])/i.test(message)
}

/** Article workflow context stays internal and preserves source-specific item identities. */
export interface ArticleResearchContext {
  /** summary is the profile value retained for durable handoff; decisionSummary is Jev-only context. */
  candidates: Array<{ id: string, name: string, aliases: string[], summary: string | null, decisionSummary?: string | null, scope: Record<string, unknown> }>
  historyByEntity: Map<string, Array<{ id: string, source: 'legacy' | 'managed', title: string, summary: string, eventAt: string }>>
  /** Fetch only selected entities after placement, then retain their latest five. */
  loadHistory?(entityId: string): Promise<Array<{ id: string, source: 'legacy' | 'managed', title: string, summary: string, eventAt: string }>>
  /** Lookup failures make placement unsafe; callers must hold before deciding. */
  coverageFailures: readonly string[]
  /** Whether all recorded coverage failures are temporary storage outages. */
  coverageFailureKind?: ArticleContextCoverageKind
  /** One expanded catalogue pass after an initial no-match/uncertain placement. */
  widenCandidates?(terms: readonly string[]): Promise<Array<{ id: string, name: string, aliases: string[], summary: string | null, decisionSummary?: string | null, scope: Record<string, unknown> }>>
  /** Exact name/alias coverage before creation, across legacy and private identities. */
  findExactEntities?(labels: readonly string[]): Promise<ArticleResearchContext['candidates']>
  /** Separate bounded source/development lookup; never replaces latest-five story context. */
  lookupOlderDuplicate?(entityId: string): Promise<Array<{ id: string, source: 'legacy' | 'managed', title: string, summary: string, eventAt: string }>>
}

export class InternalResearchEntityMemoryReader implements EntityMemoryReader {
  private readonly failures: string[] = []
  private coverageFailureKind: ArticleContextCoverageKind | undefined
  private managed: Awaited<ReturnType<ManagedResearchContextPort['researchContext']>> | null = null
  constructor(private readonly options: {
    legacy: EntityMemoryReader
    managed?: ManagedResearchContextPort
    source: string
    sourceRefs: readonly string[]
    labels: readonly string[]
  }) {
    if (!options.managed) this.recordFailure('Private managed knowledge lookup is not configured; managed history coverage is unknown.', null)
  }

  private recordFailure(message: string, error: unknown): void {
    this.failures.push(message)
    const kind: ArticleContextCoverageKind = error !== null && isTransientContextFailure(error) ? 'transient' : 'permanent'
    this.coverageFailureKind = this.coverageFailureKind === undefined
      ? kind
      : this.coverageFailureKind === kind ? kind : 'permanent'
  }

  async entityIdsForSourceRef(source: string, sourceRefId: string): Promise<string[]> {
    let legacy: string[] = []
    try { legacy = await this.options.legacy.entityIdsForSourceRef(source, sourceRefId) }
    catch (error) { this.recordFailure(`legacy identity lookup: ${String(error).slice(0, 200)}`, error) }
    if (this.options.managed) {
      try {
        this.managed = await this.options.managed.researchContext({
          source: this.options.source,
          sourceRefs: [...new Set([sourceRefId, ...this.options.sourceRefs])],
          labels: this.options.labels,
          limit: 20,
        })
      } catch (error) { this.recordFailure(`managed knowledge lookup: ${String(error).slice(0, 200)}`, error) }
    }
    return [...new Set([...legacy, ...(this.managed?.entities.map((entity) => entity.id) ?? [])])]
  }

  async entitiesByIds(ids: string[]): Promise<GateEntity[]> {
    let legacy: GateEntity[] = []
    try { legacy = await this.options.legacy.entitiesByIds(ids) }
    catch (error) { this.recordFailure(`legacy entity lookup: ${String(error).slice(0, 200)}`, error) }
    const byId = new Map(legacy.map((entity) => [entity.id, entity]))
    for (const entity of this.managed?.entities ?? []) if (ids.includes(entity.id)) byId.set(entity.id, entity)
    return [...byId.values()]
  }

  async recentMemories(entityIds: string[], limit: number): Promise<GateMemory[]> {
    let legacy: GateMemory[] = []
    try { legacy = await this.options.legacy.recentMemories(entityIds, limit) }
    catch (error) { this.recordFailure(`legacy timeline lookup: ${String(error).slice(0, 200)}`, error) }
    const managed: GateMemory[] = (this.managed?.items ?? [])
      .filter((item) => item.status === 'active')
      .flatMap((item) => item.entityIds.filter((id) => entityIds.includes(id)).map((entityId) => ({
        entityId, memoryType: 'managed_knowledge', title: item.note.slice(0, 500),
        summary: item.note.slice(0, 2_000), eventAt: item.observedAt,
      })))
    return [...legacy, ...managed].sort((a, b) => b.eventAt.localeCompare(a.eventAt)).slice(0, limit)
  }

  async noveltyEvidence(): Promise<GateNoveltyEvidence> {
    const items = this.managed?.items ?? []
    const times = items.map((item) => item.observedAt).sort()
    return {
      itemRefs: items.map((item) => item.itemId),
      timeCoverage: { oldestEventAt: times[0] ?? null, newestEventAt: times.at(-1) ?? null },
      // The model sees bounded note summaries, so omitted note text is also
      // incomplete knowledge coverage even when every row was returned.
      truncated: (this.managed?.truncated ?? false) || items.some((item) => item.status === 'active' && item.note.length > 2_000),
      failures: [...this.failures],
      digest: this.managed?.digest ?? createHash('sha256').update(JSON.stringify(this.failures)).digest('hex'),
    }
  }

  async attachmentTargetForPacket(packetId: string): Promise<{ targetId: string, revision: string | number, producerPacketId: string } | null> {
    if (!this.options.managed || this.failures.length) return null
    if (!this.managed) this.managed = await this.options.managed.researchContext({
      source: this.options.source, sourceRefs: this.options.sourceRefs, labels: this.options.labels, limit: 20,
    })
    if (this.managed.truncated) return null
    const matches = this.managed.items.filter((item) => item.status === 'active' && item.packetRefs.includes(packetId))
    if (matches.length !== 1) return null
    return { targetId: matches[0].itemId, revision: matches[0].revision, producerPacketId: packetId }
  }

  /**
   * Candidate retrieval intentionally starts from names, aliases, summaries
   * and scope labels instead of exact mentioned actors alone.  The managed
   * context remains bounded, while a caller can perform its targeted older
   * development lookup when Jev selects a candidate.
   */
  async articleContext(input: { sourceUrl: string | null, terms: readonly string[] } = { sourceUrl: null, terms: [] }): Promise<ArticleResearchContext> {
    const labels = articleLabels(this.options.labels, input.terms)
    const [exactLegacy, searchedLegacy, searchedManaged] = await Promise.all([
      this.articleLegacyEntitiesForSource(), this.articleLegacySearch(labels), this.articleManagedSearch(labels),
    ])
    const candidateProfiles = new Map<string, GateEntity>()
    for (const entity of [...searchedManaged, ...exactLegacy, ...searchedLegacy]) {
      if (!candidateProfiles.has(entity.id)) candidateProfiles.set(entity.id, entity)
    }
    const candidates = rankEntityCandidates([...candidateProfiles.values()], labels).map(articleCandidate)
    const historyByEntity = new Map<string, Array<{ id: string, source: 'legacy' | 'managed', title: string, summary: string, eventAt: string }>>()
    const historyMemo = new Map<string, Promise<ArticleHistory[]>>()
    const targetMemo = new Map<string, Promise<Array<{ id: string, source: 'legacy' | 'managed', title: string, summary: string, eventAt: string }>>>()
    const reader = this
    return {
      candidates,
      historyByEntity,
      loadHistory: (entityId) => {
        let pending = historyMemo.get(entityId)
        if (!pending) {
          pending = this.articleLatestHistory(entityId).then(history => {
            historyByEntity.set(entityId, history)
            return history
          })
          historyMemo.set(entityId, pending)
        }
        return pending
      },
      coverageFailures: this.failures,
      get coverageFailureKind() { return reader.coverageFailureKind },
      widenCandidates: async (terms) => {
        const labels = articleLabels(this.options.labels, terms)
        const [legacy, managed] = await Promise.all([
          this.articleLegacySearch(labels),
          this.articleManagedSearch(labels),
        ])
        const profiles = new Map<string, GateEntity>()
        for (const entity of [...legacy, ...managed, ...candidateProfiles.values()]) {
          if (!profiles.has(entity.id)) profiles.set(entity.id, entity)
        }
        const widened = rankEntityCandidates([...profiles.values()], labels).map(articleCandidate)
        return widened
      },
      findExactEntities: async (terms) => {
        const labels = articleLabels(terms)
        if (!this.options.managed?.articleContext) throw new Error('Exact identity coverage requires the managed article context reader')
        let legacy: GateEntity[] = []
        try {
          legacy = this.options.legacy.searchEntities
            ? await this.options.legacy.searchEntities(labels, 33, { exactOnly: true }) : []
        } catch (error) {
          this.recordFailure(`article legacy exact identity lookup: ${String(error).slice(0, 200)}`, error)
          throw error
        }
        let managed: Awaited<ReturnType<NonNullable<ManagedResearchContextPort['articleContext']>>>
        try {
          managed = await this.options.managed.articleContext({ source: this.options.source, sourceRefs: [], labels, identityOnly: true, limit: 32, historyMode: 'targeted' })
        } catch (error) {
          this.recordFailure(`article managed exact identity lookup: ${String(error).slice(0, 200)}`, error)
          throw error
        }
        if (typeof managed.candidateTruncated !== 'boolean') throw new Error('Exact identity coverage requires the current article context migration')
        if (legacy.length > 32 || managed.candidateTruncated) throw new Error('Exact article identity lookup is ambiguous beyond its candidate bound')
        return rankEntityCandidates([...legacy, ...managed.entities], labels).map(articleCandidate)
      },
      lookupOlderDuplicate: (entityId) => {
        let pending = targetMemo.get(entityId)
        if (!pending) {
          const latest = historyByEntity.get(entityId) ?? []
          pending = this.articleTargetedHistory(entityId, input, latest)
          targetMemo.set(entityId, pending)
        }
        return pending
      },
    }
  }

  private async articleLegacyEntitiesForSource(): Promise<GateEntity[]> {
    try {
      const ids = await this.options.legacy.entityIdsForSourceRef(this.options.source, this.options.sourceRefs[0] ?? '')
      return await this.options.legacy.entitiesByIds(ids)
    } catch (error) { this.recordFailure(`article legacy source entity lookup: ${String(error).slice(0, 200)}`, error); return [] }
  }

  private async articleLegacySearch(labels: string[]): Promise<GateEntity[]> {
    if (!this.options.legacy.searchEntities) return []
    try { return await this.options.legacy.searchEntities(labels, 32) }
    catch (error) { this.recordFailure(`article legacy catalogue search: ${String(error).slice(0, 200)}`, error); return [] }
  }

  private async articleManagedSearch(labels: string[]): Promise<GateEntity[]> {
    if (!this.options.managed) return []
    try {
      const managed = this.options.managed.articleContext
        ? await this.options.managed.articleContext({ source: this.options.source, sourceRefs: this.options.sourceRefs, labels, limit: 32, historyMode: 'targeted' })
        : await this.options.managed.researchContext({ source: this.options.source, sourceRefs: this.options.sourceRefs, labels, limit: 32 })
      return managed.entities
    } catch (error) { this.recordFailure(`article managed catalogue search: ${String(error).slice(0, 200)}`, error); return [] }
  }

  private async articleLatestHistory(entityId: string): Promise<Array<{ id: string, source: 'legacy' | 'managed', title: string, summary: string, eventAt: string }>> {
    const [legacy, managed] = await Promise.all([
      this.legacyHistory(entityId, 5), this.managedArticleHistory(entityId, 5, [], 'recent'),
    ])
    return uniqueHistory([...legacy, ...managed]).slice(0, 5)
  }

  private async articleTargetedHistory(entityId: string, input: { sourceUrl: string | null, terms: readonly string[] }, latest: readonly ArticleHistory[]): Promise<ArticleHistory[]> {
    const labels = articleLabels(this.options.labels, input.terms)
    const [legacy, managed] = await Promise.all([
      this.targetedLegacyHistory(entityId, labels, input.sourceUrl),
      this.managedArticleHistory(entityId, 10, labels, 'targeted', input.sourceUrl),
    ])
    const current = new Set(latest.map((item) => `${item.source}:${item.id}`))
    return uniqueHistory([...legacy, ...managed]).filter((item) => !current.has(`${item.source}:${item.id}`)).slice(0, 5)
  }

  private async legacyHistory(entityId: string, limit: number): Promise<ArticleHistory[]> {
    try {
      const memories = await this.options.legacy.recentMemories([entityId], limit)
      return memories.flatMap((memory) => memory.id?.trim()
        ? [{ id: memory.id, source: 'legacy' as const, title: memory.title, summary: memory.summary, eventAt: memory.eventAt }] : [])
    } catch (error) { this.recordFailure(`article legacy history lookup: ${String(error).slice(0, 200)}`, error); return [] }
  }

  private async targetedLegacyHistory(entityId: string, terms: string[], sourceUrl: string | null): Promise<ArticleHistory[]> {
    if (!this.options.legacy.findMemoriesForArticle) return []
    try {
      const memories = await this.options.legacy.findMemoriesForArticle({ entityIds: [entityId], terms, sourceUrl, limit: 10 })
      return memories.flatMap((memory) => memory.id?.trim()
        ? [{ id: memory.id, source: 'legacy' as const, title: memory.title, summary: memory.summary, eventAt: memory.eventAt }] : [])
    } catch (error) { this.recordFailure(`article legacy targeted lookup: ${String(error).slice(0, 200)}`, error); return [] }
  }

  private async managedArticleHistory(entityId: string, limit: number, labels: readonly string[], historyMode: 'recent' | 'targeted', sourceUrl: string | null = null): Promise<ArticleHistory[]> {
    if (!this.options.managed) return []
    try {
      const managed = this.options.managed.articleContext
        ? await this.options.managed.articleContext({
          source: this.options.source,
          sourceRefs: historyMode === 'recent' ? [] : [...new Set([
            ...(sourceUrl ? [sourceUrl] : []), ...this.options.sourceRefs,
          ])].slice(0, 32),
          labels: historyMode === 'recent' ? [] : labels,
          entityIds: [entityId], limit, historyMode,
        })
        : await this.options.managed.researchContext({ source: this.options.source, sourceRefs: this.options.sourceRefs, labels, entityIds: [entityId], limit })
      const articleItems = (managed as Partial<ManagedArticleContext>).articleItems
      if (articleItems) return articleItems.filter((item) => item.entityId === entityId).map((item) => ({
        id: item.itemId, source: item.origin, title: item.title, summary: item.summary,
        eventAt: item.eventAt ?? item.publishedAt ?? item.observedAt,
      }))
      return managed.items.filter((item) => item.status === 'active' && item.entityIds.includes(entityId)).map((item) => ({
        id: item.itemId, source: 'managed' as const, title: item.note.slice(0, 500), summary: item.note.slice(0, 2_000), eventAt: item.observedAt,
      }))
    } catch (error) { this.recordFailure(`article managed history lookup: ${String(error).slice(0, 200)}`, error); return [] }
  }
}

type ArticleHistory = { id: string, source: 'legacy' | 'managed', title: string, summary: string, eventAt: string }

function articleCandidate(entity: GateEntity): ArticleResearchContext['candidates'][number] {
  return {
    id: entity.id, name: entity.name, aliases: [...(entity.aliases ?? [])], summary: entity.summary,
    decisionSummary: articleCandidateDecisionSummary(entity.summary),
    scope: { slug: entity.slug, type: entity.type ?? null, metadata: articleScope(entity.metadata ?? {}), source: 'catalogue' },
  }
}

/** Placement uses domain scope; historical execution receipts are not scope. */
function articleScope(metadata: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(metadata).filter(([key]) =>
    !/^(canonical_|image_|freshness_|priority_|research_)/.test(key)
    && (!key.startsWith('entity_') || ['entity_kind', 'entity_class'].includes(key))
    && !['provider_id', 'create_reason', 'upstream_source_name'].includes(key)))
}

function articleLabels(...groups: ReadonlyArray<readonly string[]>): string[] {
  return [...new Set(groups.flat().map((value) => value.trim()).filter((value) => value.length >= 2))].slice(0, 64)
}

function uniqueHistory(items: ArticleHistory[]): ArticleHistory[] {
  const byId = new Map<string, ArticleHistory>()
  for (const item of items) if (item.id.trim() && !byId.has(`${item.source}:${item.id}`)) byId.set(`${item.source}:${item.id}`, item)
  return [...byId.values()].sort((left, right) =>
    historyTime(right.eventAt) - historyTime(left.eventAt)
      || `${left.source}:${left.id}`.localeCompare(`${right.source}:${right.id}`),
  )
}

function historyTime(value: string): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}
