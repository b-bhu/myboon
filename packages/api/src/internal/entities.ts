import { Hono } from 'hono'
import type { Context } from 'hono'
import { timingSafeEqual } from 'node:crypto'

type SortMode = 'updated_desc' | 'memory_count_desc' | 'name_asc'

interface InternalEntityRoutesConfig {
  supabaseUrl: string
  serviceRoleKey: string
  internalToken?: string
}

interface EntityRow {
  id: string
  slug: string
  name: string
  type: string
  aliases: unknown
  summary: string | null
  status: string
  show_in_carousel?: boolean
  metadata?: unknown
  created_at: string
  updated_at: string
}

interface MemoryRow {
  id: string
  entity_id: string | null
  source: string
  source_area: string
  source_type: string
  source_ref_id: string
  source_research_id: string
  memory_type: string
  title: string
  summary: string
  body: string | null
  event_at: string | null
  observed_at: string
  confidence: string | number | null
  evidence: unknown
  mentions: unknown
  metrics: unknown
  context: unknown
  created_at: string
  updated_at: string
}

interface PublishedHistoryRow {
  id: string
  published_narrative_id: string
  title: string | null
  angle: string | null
  source: string | null
  source_area: string | null
  published_at: string
}

interface MemoryStats {
  memoryCount: number
  latestMemoryAt: string | null
  sourceCount: number
  evidenceCount: number
}

interface MemoryStatsRow {
  entity_id: string
  memory_count: string | number
  latest_memory_at: string | null
  source_count: string | number
  evidence_count: string | number
}

const ENTITY_SELECT = 'id,slug,name,type,aliases,summary,status,show_in_carousel,metadata,created_at,updated_at'
const LEGACY_ENTITY_SELECT = 'id,slug,name,type,aliases,summary,status,metadata,created_at,updated_at'
const MEMORY_SELECT = 'id,entity_id,source,source_area,source_type,source_ref_id,source_research_id,memory_type,title,summary,body,event_at,observed_at,confidence,evidence,mentions,metrics,context,created_at,updated_at'
const PUBLISHED_HISTORY_SELECT = 'id,published_narrative_id,title,angle,source,source_area,published_at'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SAFE_IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const SAFE_FILTER_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const MIN_INTERNAL_TOKEN_LENGTH = 32
const MAX_CURSOR_OFFSET = 100_000

export function createInternalEntityRoutes(config: InternalEntityRoutesConfig): Hono {
  const app = new Hono()
  const restBaseUrl = `${config.supabaseUrl.replace(/\/$/, '')}/rest/v1`

  function supabaseHeaders(count = false): Record<string, string> {
    const headers: Record<string, string> = {
      apikey: config.serviceRoleKey,
      Authorization: `Bearer ${config.serviceRoleKey}`,
      'Content-Type': 'application/json',
    }
    if (count) headers.Prefer = 'count=exact'
    return headers
  }

  async function restFetch(table: string, params: URLSearchParams, options: { count?: boolean } = {}): Promise<Response> {
    const url = new URL(`${restBaseUrl}/${table}`)
    params.forEach((value, key) => url.searchParams.append(key, value))
    return fetch(url, {
      headers: supabaseHeaders(Boolean(options.count)),
      signal: AbortSignal.timeout(10_000),
    })
  }

  async function restRpc<T>(functionName: string, payload: unknown): Promise<T[]> {
    const res = await fetch(`${restBaseUrl}/rpc/${functionName}`, {
      method: 'POST',
      headers: supabaseHeaders(),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`Supabase RPC failed for ${functionName}: ${res.status}`)
    return res.json() as Promise<T[]>
  }

  async function readRows<T>(table: string, params: URLSearchParams, options: { count?: boolean; optional?: boolean } = {}): Promise<{ rows: T[]; count: number | null }> {
    const res = await restFetch(table, params, { count: options.count })
    if (!res.ok) {
      if (options.optional && (res.status === 400 || res.status === 404)) {
        console.warn(`[internal/entities] optional Supabase read failed for ${table}: ${res.status}`)
        return { rows: [], count: 0 }
      }
      const detail = (await res.text()).slice(0, 500)
      throw new Error(`Supabase read failed for ${table}: ${res.status}: ${detail}`)
    }
    const rows = await res.json() as T[]
    return { rows, count: parseContentRangeCount(res.headers.get('content-range')) }
  }

  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'private, no-store, max-age=0')
    c.header('Pragma', 'no-cache')
    c.header('X-Robots-Tag', 'noindex, nofollow, noarchive')
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('Referrer-Policy', 'no-referrer')
    c.header('Vary', 'Authorization')

    if (!hasSecureToken(config.internalToken)) {
      return c.json({ error: 'Internal dashboard token is not configured' }, 503)
    }

    const auth = c.req.header('authorization') ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : ''
    if (!tokensMatch(token, config.internalToken)) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    await next()
  })

  app.get('/entities', async (c) => {
    try {
      const query = normalizedQuery(c.req.query('q'))
      const type = normalizedFilter(c.req.query('type'))
      const status = normalizedFilter(c.req.query('status'))
      const sort = parseSort(c.req.query('sort'))
      const limit = clampInteger(c.req.query('limit'), 50, 1, 100)
      const offset = decodeCursor(c.req.query('cursor'))
      const usesLocalPagination = Boolean(query) || sort === 'memory_count_desc'

      const fetchLimit = usesLocalPagination ? 300 : limit + 1
      const { rows: baseRows } = await fetchEntityRows({
        query,
        type,
        status,
        sort,
        limit: fetchLimit,
        offset: usesLocalPagination ? 0 : offset,
      })

      const memoryMatchedRows = query
        ? await fetchEntitiesFromMemorySearch(query, type, status)
        : []

      const mergedRows = dedupeEntities([...baseRows, ...memoryMatchedRows])
      const filteredRows = filterRowsLocally(mergedRows, { query, type, status })
      const enriched = await enrichEntities(filteredRows)
      const sorted = sortEntityList(enriched, sort)
      const page = usesLocalPagination
        ? sorted.slice(offset, offset + limit)
        : sorted.slice(0, limit)
      const nextCursor = usesLocalPagination
        ? (sorted.length > offset + limit ? encodeCursor(offset + limit) : null)
        : (sorted.length > limit ? encodeCursor(offset + limit) : null)

      return c.json({ entities: page, nextCursor })
    } catch (err) {
      return internalError(c, err, 'GET /internal/entities')
    }
  })

  app.get('/entities/:id', async (c) => {
    try {
      const id = normalizedIdentifier(c.req.param('id'))
      if (!id) return c.json({ error: 'Invalid entity identifier' }, 400)
      const entity = await fetchEntityByIdOrSlug(id)
      if (!entity) return c.json({ error: 'Entity not found' }, 404)

      const [stats, relatedEntities, publishedHistory, publishedNarrativeCount] = await Promise.all([
        fetchMemoryStats(entity.id),
        inferRelatedEntities(entity),
        fetchPublishedHistory(entity),
        fetchPublishedNarrativeCount(entity.id),
      ])

      return c.json({
        entity: mapEntityDetail(entity),
        stats: {
          ...stats,
          relatedEntityCount: relatedEntities.length,
          publishedNarrativeCount,
        },
        relatedEntities,
        publishedHistory,
      })
    } catch (err) {
      return internalError(c, err, 'GET /internal/entities/:id')
    }
  })

  app.get('/entities/:id/timeline', async (c) => {
    try {
      const id = normalizedIdentifier(c.req.param('id'))
      if (!id) return c.json({ error: 'Invalid entity identifier' }, 400)
      const entity = await fetchEntityByIdOrSlug(id)
      if (!entity) return c.json({ error: 'Entity not found' }, 404)

      const limit = clampInteger(c.req.query('limit'), 30, 1, 100)
      const offset = decodeCursor(c.req.query('cursor'))
      const { rows } = await fetchMemoryRows(entity.id, {
        limit,
        offset,
        memoryType: normalizedFilter(c.req.query('memory_type')),
        source: normalizedFilter(c.req.query('source')),
      })
      const memories = rows.map(mapMemoryItem)
      const nextCursor = rows.length === limit ? encodeCursor(offset + limit) : null

      return c.json({ memories, nextCursor })
    } catch (err) {
      return internalError(c, err, 'GET /internal/entities/:id/timeline')
    }
  })

  async function readEntityRows(params: URLSearchParams): Promise<{ rows: EntityRow[]; count: number | null }> {
    params.set('select', ENTITY_SELECT)
    try {
      return await readRows<EntityRow>('entities', params)
    } catch (error) {
      if (!isMissingCarouselColumnError(error)) throw error
      params.set('select', LEGACY_ENTITY_SELECT)
      return readRows<EntityRow>('entities', params)
    }
  }

  async function fetchEntityRows(input: {
    query: string
    type: string
    status: string
    sort: SortMode
    limit: number
    offset: number
  }): Promise<{ rows: EntityRow[] }> {
    const params = new URLSearchParams()
    params.set('select', ENTITY_SELECT)
    params.set('limit', String(input.limit))
    params.set('offset', String(input.offset))
    params.set('order', input.sort === 'name_asc' ? 'name.asc' : 'updated_at.desc')

    if (input.type) params.set('type', `eq.${input.type}`)
    if (input.status) params.set('status', `eq.${input.status}`)
    if (input.query) {
      const pattern = postgrestSearchPattern(input.query)
      params.set('or', `(name.ilike.${pattern},slug.ilike.${pattern},type.ilike.${pattern},status.ilike.${pattern},summary.ilike.${pattern})`)
    }

    return readEntityRows(params)
  }

  async function fetchEntitiesFromMemorySearch(query: string, type: string, status: string): Promise<EntityRow[]> {
    const params = new URLSearchParams()
    const pattern = postgrestSearchPattern(query)
    params.set('select', 'entity_id')
    params.set('entity_id', 'not.is.null')
    params.set('or', `(title.ilike.${pattern},summary.ilike.${pattern},body.ilike.${pattern},source_ref_id.ilike.${pattern},source_research_id.ilike.${pattern})`)
    params.set('limit', '200')

    const { rows } = await readRows<{ entity_id: string | null }>('entity_memories', params)
    const ids = [...new Set(rows.map((row) => row.entity_id).filter((id): id is string => Boolean(id)))]
    if (ids.length === 0) return []
    const entityRows = await fetchEntitiesByIds(ids)
    return filterRowsLocally(entityRows, { query: '', type, status })
  }

  async function fetchEntitiesByIds(ids: string[]): Promise<EntityRow[]> {
    const rows: EntityRow[] = []
    for (const chunk of chunks(ids, 80)) {
      const params = new URLSearchParams()
      params.set('select', ENTITY_SELECT)
      params.set('id', `in.(${chunk.join(',')})`)
      params.set('limit', String(chunk.length))
      const result = await readEntityRows(params)
      rows.push(...result.rows)
    }
    return rows
  }

  async function fetchEntityByIdOrSlug(idOrSlug: string): Promise<EntityRow | null> {
    const params = new URLSearchParams()
    params.set('select', ENTITY_SELECT)
    params.set(UUID_RE.test(idOrSlug) ? 'id' : 'slug', `eq.${idOrSlug}`)
    params.set('limit', '1')
    const { rows } = await readEntityRows(params)
    const direct = rows[0] ?? null
    const sourceId = direct?.id ?? (UUID_RE.test(idOrSlug) ? idOrSlug : null)
    if (!sourceId || direct?.status === 'active') return direct

    const redirectParams = new URLSearchParams()
    redirectParams.set('select', 'target_entity_id')
    redirectParams.set('source_entity_id', `eq.${sourceId}`)
    redirectParams.set('limit', '1')
    const redirect = await readRows<{ target_entity_id: string }>('entity_redirects', redirectParams, { optional: true })
    const targetId = redirect.rows[0]?.target_entity_id
    if (!targetId || !UUID_RE.test(targetId) || targetId === sourceId) return direct

    const targetParams = new URLSearchParams()
    targetParams.set('select', ENTITY_SELECT)
    targetParams.set('id', `eq.${targetId}`)
    targetParams.set('limit', '1')
    const target = await readEntityRows(targetParams)
    return target.rows[0] ?? direct
  }

  async function enrichEntities(rows: EntityRow[]) {
    const statsByEntityId = await fetchMemoryStatsForEntities(rows.map((row) => row.id))
    return rows.map((row) => {
      const stats = statsByEntityId.get(row.id) ?? emptyMemoryStats()
      return {
        id: row.id,
        slug: row.slug,
        name: row.name,
        type: row.type,
        status: row.status,
        showInCarousel: Boolean(row.show_in_carousel),
        aliases: stringArray(row.aliases),
        summary: row.summary,
        memoryCount: stats.memoryCount,
        latestMemoryAt: stats.latestMemoryAt,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    })
  }

  async function fetchMemoryStats(entityId: string): Promise<MemoryStats> {
    try {
      const rows = await restRpc<MemoryStatsRow>('internal_entity_memory_stats', { entity_ids: [entityId] })
      const row = rows[0]
      return row ? {
        memoryCount: integer(row.memory_count),
        latestMemoryAt: row.latest_memory_at,
        sourceCount: integer(row.source_count),
        evidenceCount: integer(row.evidence_count),
      } : emptyMemoryStats()
    } catch (err) {
      if (!isMissingStatsRpc(err)) throw err
      return fetchLegacyMemoryStats(entityId, 500)
    }
  }

  async function fetchMemoryStatsForEntities(entityIds: string[]): Promise<Map<string, MemoryStats>> {
    if (entityIds.length === 0) return new Map()
    try {
      const rows = await restRpc<MemoryStatsRow>('internal_entity_memory_stats', { entity_ids: entityIds })
      return new Map(rows.map((row) => [row.entity_id, {
        memoryCount: integer(row.memory_count),
        latestMemoryAt: row.latest_memory_at,
        sourceCount: integer(row.source_count),
        evidenceCount: integer(row.evidence_count),
      }]))
    } catch (err) {
      if (!isMissingStatsRpc(err)) throw err
      console.warn('[internal/entities] aggregate RPC is unavailable; using compatibility stats reads until the migration is applied')
      const entries = await mapWithConcurrency(entityIds, 8, async (entityId) => [entityId, await fetchLegacyMemoryStats(entityId, 1)] as const)
      return new Map(entries)
    }
  }

  async function fetchLegacyMemoryStats(entityId: string, sampleLimit: number): Promise<MemoryStats> {
    const params = new URLSearchParams()
    params.set('select', 'id,observed_at,evidence,source')
    params.set('entity_id', `eq.${entityId}`)
    params.set('order', 'observed_at.desc,created_at.desc')
    params.set('limit', String(sampleLimit))

    const { rows, count } = await readRows<{ observed_at: string; evidence: unknown; source: string }>('entity_memories', params, { count: true })
    const sources = new Set(rows.map((row) => row.source).filter(Boolean))
    const evidenceCount = rows.reduce((sum, row) => sum + jsonArray(row.evidence).length, 0)
    return {
      memoryCount: count ?? rows.length,
      latestMemoryAt: rows[0]?.observed_at ?? null,
      sourceCount: sources.size,
      evidenceCount,
    }
  }

  async function fetchMemoryRows(entityId: string, input: {
    limit: number
    offset: number
    memoryType?: string
    source?: string
  }): Promise<{ rows: MemoryRow[]; count: number | null }> {
    const params = new URLSearchParams()
    params.set('select', MEMORY_SELECT)
    params.set('entity_id', `eq.${entityId}`)
    params.set('order', 'observed_at.desc,created_at.desc')
    params.set('limit', String(input.limit))
    params.set('offset', String(input.offset))
    if (input.memoryType) params.set('memory_type', `eq.${input.memoryType}`)
    if (input.source) params.set('source', `eq.${input.source}`)
    return readRows<MemoryRow>('entity_memories', params, { count: true })
  }

  async function fetchPublishedHistory(entity: EntityRow): Promise<ReturnType<typeof mapPublishedHistory>[]> {
    const params = new URLSearchParams()
    params.set('select', PUBLISHED_HISTORY_SELECT)
    params.set('or', `(entity_id.eq.${entity.id},entity_slug.eq.${entity.slug})`)
    params.set('order', 'published_at.desc')
    params.set('limit', '20')
    const { rows } = await readRows<PublishedHistoryRow>('entity_published_history', params, { optional: true })
    return rows.map(mapPublishedHistory)
  }

  async function fetchPublishedNarrativeCount(entityId: string): Promise<number> {
    const params = new URLSearchParams()
    params.set('select', 'id')
    params.set('entity_id', `eq.${entityId}`)
    params.set('limit', '1')
    const { count } = await readRows<{ id: string }>('published_narratives', params, { count: true, optional: true })
    return count ?? 0
  }

  async function inferRelatedEntities(entity: EntityRow) {
    const [memoryResult, allEntities] = await Promise.all([
      fetchMemoryRows(entity.id, { limit: 200, offset: 0 }),
      fetchEntityRows({ query: '', type: '', status: '', sort: 'updated_desc', limit: 500, offset: 0 }),
    ])
    const memories = memoryResult.rows
    const candidates = allEntities.rows.filter((candidate) => candidate.id !== entity.id)
    const haystacks = memories.map((memory) => ({
      observedAt: memory.observed_at,
      text: collectStrings([memory.title, memory.summary, memory.body, memory.mentions, memory.context, memory.evidence]).join(' ').toLowerCase(),
    }))

    return candidates
      .map((candidate) => {
        const terms = [candidate.slug, candidate.name, ...stringArray(candidate.aliases)]
          .map((term) => term.toLowerCase().trim())
          .filter((term) => term.length >= 2)
        const matched = haystacks.filter((haystack) => terms.some((term) => haystack.text.includes(term)))
        if (matched.length === 0) return null
        return {
          id: candidate.id,
          slug: candidate.slug,
          name: candidate.name,
          type: candidate.type,
          reason: `Mentioned in ${matched.length} saved ${matched.length === 1 ? 'memory' : 'memories'}`,
          sharedMemoryCount: matched.length,
          latestObservedAt: matched.map((item) => item.observedAt).sort().at(-1) ?? null,
          inference: 'inferred' as const,
        }
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .sort((left, right) => {
        if (right.sharedMemoryCount !== left.sharedMemoryCount) return right.sharedMemoryCount - left.sharedMemoryCount
        return (right.latestObservedAt ?? '').localeCompare(left.latestObservedAt ?? '')
      })
      .slice(0, 12)
  }

  return app
}

function internalError(c: Context, err: unknown, label: string) {
  console.error(`[internal/entities] ${label} failed`, err instanceof Error ? err.message : 'unknown error')
  return c.json({ error: 'Internal server error' }, 500)
}

function mapEntityDetail(row: EntityRow) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    type: row.type,
    status: row.status,
    showInCarousel: Boolean(row.show_in_carousel),
    aliases: stringArray(row.aliases),
    summary: row.summary,
    metadata: record(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapMemoryItem(row: MemoryRow) {
  return {
    id: row.id,
    entityId: row.entity_id,
    source: row.source,
    sourceArea: row.source_area,
    sourceType: row.source_type,
    sourceRefId: row.source_ref_id,
    sourceResearchId: row.source_research_id,
    memoryType: row.memory_type,
    title: row.title,
    summary: row.summary,
    body: row.body,
    eventAt: row.event_at,
    observedAt: row.observed_at,
    confidence: nullableNumber(row.confidence),
    evidence: jsonArray(row.evidence),
    mentions: jsonArray(row.mentions),
    metrics: record(row.metrics),
    context: record(row.context),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapPublishedHistory(row: PublishedHistoryRow) {
  return {
    id: row.id,
    publishedNarrativeId: row.published_narrative_id,
    title: row.title,
    angle: row.angle,
    source: row.source,
    sourceArea: row.source_area,
    publishedAt: row.published_at,
  }
}

function sortEntityList<T extends { name: string; updatedAt: string; memoryCount: number }>(items: T[], sort: SortMode): T[] {
  return [...items].sort((left, right) => {
    if (sort === 'name_asc') return left.name.localeCompare(right.name)
    if (sort === 'memory_count_desc') {
      if (right.memoryCount !== left.memoryCount) return right.memoryCount - left.memoryCount
      return right.updatedAt.localeCompare(left.updatedAt)
    }
    return right.updatedAt.localeCompare(left.updatedAt)
  })
}

function filterRowsLocally(rows: EntityRow[], filters: { query: string; type: string; status: string }): EntityRow[] {
  return rows.filter((row) => {
    if (filters.type && row.type !== filters.type) return false
    if (filters.status && row.status !== filters.status) return false
    if (!filters.query) return true
    const query = filters.query.toLowerCase()
    const haystack = [row.name, row.slug, row.type, row.status, row.summary, ...stringArray(row.aliases)]
      .join(' ')
      .toLowerCase()
    return haystack.includes(query)
  })
}

function dedupeEntities(rows: EntityRow[]): EntityRow[] {
  const seen = new Set<string>()
  const deduped: EntityRow[] = []
  for (const row of rows) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    deduped.push(row)
  }
  return deduped
}

function parseSort(input: string | undefined): SortMode {
  if (input === 'memory_count_desc' || input === 'name_asc') return input
  return 'updated_desc'
}

function normalizedQuery(input: string | undefined): string {
  return (input ?? '')
    .replace(/[^A-Za-z0-9\s_-]/g, ' ')
    .trim()
    .slice(0, 120)
}

function normalizedFilter(input: string | undefined): string {
  const value = (input ?? '').trim()
  return SAFE_FILTER_RE.test(value) ? value : ''
}

function normalizedIdentifier(input: string): string {
  return UUID_RE.test(input) || SAFE_IDENTIFIER_RE.test(input) ? input : ''
}

function postgrestSearchPattern(input: string): string {
  return `*${input.replace(/[(),]/g, ' ').trim().replace(/\s+/g, '*')}*`
}

function clampInteger(input: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(input ?? '', 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url')
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8')
  if (!/^\d+$/.test(decoded)) return 0
  const parsed = Number.parseInt(decoded, 10)
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= MAX_CURSOR_OFFSET ? parsed : 0
}

function parseContentRangeCount(value: string | null): number | null {
  if (!value) return null
  const count = value.split('/')[1]
  if (!count || count === '*') return null
  const parsed = Number.parseInt(count, 10)
  return Number.isFinite(parsed) ? parsed : null
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function jsonArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function nullableNumber(value: string | number | null): number | null {
  if (value === null) return null
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : null
}

function integer(value: string | number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}

function emptyMemoryStats(): MemoryStats {
  return { memoryCount: 0, latestMemoryAt: null, sourceCount: 0, evidenceCount: 0 }
}

function isMissingStatsRpc(err: unknown): boolean {
  return err instanceof Error && err.message === 'Supabase RPC failed for internal_entity_memory_stats: 404'
}

function isMissingCarouselColumnError(err: unknown): boolean {
  return err instanceof Error
    && /show_in_carousel/i.test(err.message)
    && /column|schema cache|does not exist|PGRST204/i.test(err.message)
}

function hasSecureToken(token: string | undefined): token is string {
  return Boolean(token && Buffer.byteLength(token, 'utf8') >= MIN_INTERNAL_TOKEN_LENGTH)
}

function tokensMatch(token: string, expected: string): boolean {
  const left = Buffer.from(token)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

function collectStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(collectStrings)
  if (value && typeof value === 'object') return Object.values(value).flatMap(collectStrings)
  return []
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size))
  }
  return result
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  let nextIndex = 0

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await fn(items[index])
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  return results
}
