import { Hono } from 'hono'
import type { Context } from 'hono'
import type { EntityKnowledgeMemoryV1, EntityKnowledgeReader } from '@myboon/collectors/entity-manager'
import entityManager from '@myboon/collectors/entity-manager'

const { ENTITY_KNOWLEDGE_MAX_PAGE_SIZE } = entityManager

const MAX_STORIES = 5
const DEFAULT_STORY_EVENT_LIMIT = 20
const MAX_STORY_EVENT_LIMIT = 50
const MAX_STORY_EVENT_OFFSET = 10_000
const REQUEST_TIMEOUT_MS = 10_000
const SAFE_STORY_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ENTITY_SELECT = 'id,slug,name'
// Atlas shelves carry the story card image inside the jsonb `card` column
// (card.image = { url, source }); the PostgREST alias reads it as plain text.
const ATLAS_SHELF_SELECT = 'id,slug,name,type,image:card->image->>url'
const ATLAS_ITEM_SELECT = 'id,title,summary,occurred_at'

interface EntityRow {
  id: unknown
  slug: unknown
  name: unknown
}

interface AtlasShelfRow extends EntityRow {
  type: unknown
  image: unknown
}

interface AtlasItemRow {
  id: unknown
  title: unknown
  summary: unknown
  occurred_at: unknown
}

interface SelectedEntity {
  id: string
  slug: string
  name: string
  /** Atlas shelf type; null on legacy Entities. */
  type: string | null
  /** Atlas shelf card image URL; null on legacy Entities. */
  imageUrl: string | null
}

interface StoryMemory {
  entityId: string
  summary: string
  eventAt: string
  imageUrl: string | null
  imageKind: StoryImageKind | null
  imageAttribution: string | null
}

export type StoryImageKind = 'content' | 'source_avatar'

export interface StorySummary {
  storySlug: string
  name: string
  latestDevelopment: string
  eventCount: number
  updatedAt: string
  imageUrl: string | null
  imageKind: StoryImageKind | null
  imageAttribution: string | null
  /** Atlas shelf type (lets the client pick a placeholder per type); null on legacy. */
  shelfType: string | null
}

export interface StoryEvent {
  text: string
  eventAt: string
  imageUrl: string | null
  imageKind: StoryImageKind | null
  imageAttribution: string | null
}

export interface StoryPagination {
  limit: number
  offset: number
  total: number
  hasMore: boolean
  nextOffset: number | null
}

export interface StoryRoutesConfig {
  supabaseUrl: string
  serviceRoleKey: string
  memoryReader: Pick<EntityKnowledgeReader, 'getEntityMemoryEvents'>
  /** Backing store for Stories; 'atlas' reads the PostgREST atlas schema. Anything else (or missing) is legacy. */
  source?: 'legacy' | 'atlas'
  fetch?: typeof globalThis.fetch
}

/**
 * Public Story API. A Story is a deliberately selected Entity projected as a
 * minimal, chronological list of its public-safe Entity memory summaries.
 */
export function createStoryRoutes(config: StoryRoutesConfig): Hono {
  const app = new Hono()
  const fetchImpl = config.fetch ?? globalThis.fetch
  const restBaseUrl = `${config.supabaseUrl.replace(/\/$/, '')}/rest/v1`
  const atlas = config.source === 'atlas'

  function restUrl(table: string, params: URLSearchParams): URL {
    const url = new URL(`${restBaseUrl}/${table}`)
    params.forEach((value, key) => url.searchParams.append(key, value))
    return url
  }

  function restHeaders(schema?: 'atlas'): Record<string, string> {
    return {
      apikey: config.serviceRoleKey,
      Authorization: `Bearer ${config.serviceRoleKey}`,
      Accept: 'application/json',
      // PostgREST schema select: only the atlas source switches the profile header.
      ...(schema === 'atlas' ? { 'Accept-Profile': 'atlas' } : {}),
    }
  }

  async function readRows<T>(table: string, params: URLSearchParams, schema?: 'atlas'): Promise<T[]> {
    const response = await fetchImpl(restUrl(table, params), {
      headers: restHeaders(schema),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) {
      throw new Error(`Supabase read failed for ${table}: ${response.status}`)
    }
    const body: unknown = await response.json()
    if (!Array.isArray(body)) throw new Error(`Supabase returned an invalid ${table} response`)
    return body as T[]
  }

  async function selectedEntities(): Promise<SelectedEntity[]> {
    const params = new URLSearchParams({
      select: ENTITY_SELECT,
      show_in_carousel: 'eq.true',
      order: 'updated_at.desc',
      limit: String(MAX_STORIES),
    })
    const rows = await readRows<EntityRow>('entities', params)
    return rows.map(selectedEntity).filter((row): row is SelectedEntity => row !== null).slice(0, MAX_STORIES)
  }

  async function selectedEntityBySlug(storySlug: string): Promise<SelectedEntity | null> {
    const params = new URLSearchParams({
      select: ENTITY_SELECT,
      slug: `eq.${storySlug}`,
      show_in_carousel: 'eq.true',
      limit: '1',
    })
    const rows = await readRows<EntityRow>('entities', params)
    return selectedEntity(rows[0])
  }

  async function storyMemories(entityIds: string[]): Promise<{
    memoriesByEntity: Map<string, StoryMemory[]>,
    totalsByEntity: Map<string, number>,
  }> {
    const grouped = new Map<string, StoryMemory[]>()
    const totals = new Map<string, number>()
    if (entityIds.length === 0) return { memoriesByEntity: grouped, totalsByEntity: totals }
    await Promise.all(entityIds.filter((id) => UUID_RE.test(id)).map(async (entityId) => {
      const page = await config.memoryReader.getEntityMemoryEvents({ entityId, limit: 1 })
      const memory = page.items[0] ? storyMemory(page.items[0]) : null
      const expectedItems = page.totalCount === 0 ? 0 : 1
      if (
        page.items.length !== expectedItems
        || (expectedItems === 1 && (!memory || memory.entityId !== entityId))
        || page.hasMore !== (page.totalCount > 1)
        || (page.hasMore && !page.nextCursor)
      ) {
        throw new Error('Entity memory event page was incomplete')
      }
      if (memory) grouped.set(entityId, [memory])
      totals.set(entityId, page.totalCount)
    }))
    return { memoriesByEntity: grouped, totalsByEntity: totals }
  }

  async function storyMemoryPage(entityId: string, limit: number, offset: number): Promise<{
    memories: StoryMemory[]
    total: number
    latest: StoryMemory | null
  }> {
    if (!UUID_RE.test(entityId)) return { memories: [], total: 0, latest: null }
    const memories: StoryMemory[] = []
    let cursor: string | undefined
    let consumed = 0
    let total: number | null = null
    let latest: StoryMemory | null = null
    while (consumed < offset + limit) {
      const page = await config.memoryReader.getEntityMemoryEvents({
        entityId,
        limit: Math.min(ENTITY_KNOWLEDGE_MAX_PAGE_SIZE, offset + limit - consumed),
        ...(cursor ? { cursor } : {}),
      })
      if (total !== null && page.totalCount !== total) throw new Error('Entity memory event count changed during pagination')
      total = page.totalCount
      for (const item of page.items) {
        const memory = storyMemory(item)
        if (!memory || memory.entityId !== entityId) throw new Error('Entity memory event page was incomplete')
        latest ??= memory
        if (consumed >= offset && memories.length < limit) memories.push(memory)
        consumed += 1
      }
      if (consumed >= offset + limit || !page.hasMore) break
      if (!page.nextCursor || page.items.length === 0) throw new Error('Entity memory event page was incomplete')
      cursor = page.nextCursor
    }
    const exactTotal = total ?? 0
    const expected = Math.min(limit, Math.max(0, exactTotal - offset))
    if (consumed < Math.min(offset, exactTotal) || memories.length !== expected) {
      throw new Error('Entity memory event page was incomplete')
    }
    return { memories, total: exactTotal, latest }
  }

  async function atlasSelectedEntities(): Promise<SelectedEntity[]> {
    const params = new URLSearchParams({
      select: ATLAS_SHELF_SELECT,
      show_in_carousel: 'eq.true',
      status: 'eq.active',
      order: 'updated_at.desc',
      limit: String(MAX_STORIES),
    })
    const rows = await readRows<AtlasShelfRow>('shelves', params, 'atlas')
    return rows.map(atlasSelectedEntity).filter((row): row is SelectedEntity => row !== null).slice(0, MAX_STORIES)
  }

  async function atlasSelectedEntityBySlug(storySlug: string): Promise<SelectedEntity | null> {
    const params = new URLSearchParams({
      select: ATLAS_SHELF_SELECT,
      slug: `eq.${storySlug}`,
      show_in_carousel: 'eq.true',
      status: 'eq.active',
      limit: '1',
    })
    const rows = await readRows<AtlasShelfRow>('shelves', params, 'atlas')
    return atlasSelectedEntity(rows[0])
  }

  async function atlasItemsTotal(shelfId: string): Promise<number> {
    const response = await fetchImpl(restUrl('items', atlasItemFilterParams(shelfId)), {
      headers: { ...restHeaders('atlas'), Prefer: 'count=exact', Range: '0-0' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) {
      throw new Error(`Supabase read failed for items: ${response.status}`)
    }
    const total = contentRangeTotal(response.headers.get('Content-Range'))
    if (total === null) throw new Error('Supabase returned an invalid items count')
    return total
  }

  async function atlasStoryMemories(shelfIds: string[]): Promise<{
    memoriesByEntity: Map<string, StoryMemory[]>,
    totalsByEntity: Map<string, number>,
  }> {
    const grouped = new Map<string, StoryMemory[]>()
    const totals = new Map<string, number>()
    if (shelfIds.length === 0) return { memoriesByEntity: grouped, totalsByEntity: totals }
    await Promise.all(shelfIds.filter((shelfId) => UUID_RE.test(shelfId)).map(async (shelfId) => {
      const [latestRows, total] = await Promise.all([
        readRows<AtlasItemRow>('items', atlasItemParams(shelfId, 1, 0), 'atlas'),
        atlasItemsTotal(shelfId),
      ])
      const expected = total > 0 ? 1 : 0
      const memory = atlasMemory(latestRows[0], shelfId)
      if (latestRows.length !== expected || (expected === 1 && (!memory || memory.entityId !== shelfId))) {
        throw new Error('Atlas item page was incomplete')
      }
      if (memory) grouped.set(shelfId, [memory])
      totals.set(shelfId, total)
    }))
    return { memoriesByEntity: grouped, totalsByEntity: totals }
  }

  async function atlasItemPage(shelfId: string, limit: number, offset: number): Promise<{
    memories: StoryMemory[]
    total: number
    latest: StoryMemory | null
  }> {
    if (!UUID_RE.test(shelfId)) return { memories: [], total: 0, latest: null }
    const [rows, total] = await Promise.all([
      readRows<AtlasItemRow>('items', atlasItemParams(shelfId, limit, offset), 'atlas'),
      atlasItemsTotal(shelfId),
    ])
    const memories: StoryMemory[] = []
    for (const row of rows) {
      const memory = atlasMemory(row, shelfId)
      if (!memory || memory.entityId !== shelfId) throw new Error('Atlas item page was incomplete')
      memories.push(memory)
    }
    const expected = Math.min(limit, Math.max(0, total - offset))
    if (memories.length !== expected) throw new Error('Atlas item page was incomplete')
    let latest: StoryMemory | null = null
    if (total > 0) {
      if (offset === 0) {
        latest = memories[0] ?? null
      } else {
        const latestRows = await readRows<AtlasItemRow>('items', atlasItemParams(shelfId, 1, 0), 'atlas')
        latest = atlasMemory(latestRows[0], shelfId)
      }
      if (!latest) throw new Error('Atlas item page was incomplete')
    }
    return { memories, total, latest }
  }

  const listEntities = atlas ? atlasSelectedEntities : selectedEntities
  const listMemories = atlas ? atlasStoryMemories : storyMemories
  const entityBySlug = atlas ? atlasSelectedEntityBySlug : selectedEntityBySlug
  const memoryPage = atlas ? atlasItemPage : storyMemoryPage

  app.get('/', async (c) => {
    try {
      const entities = await listEntities()
      const { memoriesByEntity, totalsByEntity } = await listMemories(entities.map((entity) => entity.id))
      const stories = entities.flatMap((entity) => {
        const memories = memoriesByEntity.get(entity.id) ?? []
        const story = storySummary(entity, memories, totalsByEntity.get(entity.id) ?? memories.length)
        return story ? [story] : []
      })
      return c.json({ stories })
    } catch (error) {
      return storyError(c, error, 'GET /stories')
    }
  })

  app.get('/:storySlug', async (c) => {
    const storySlug = c.req.param('storySlug')
    if (!SAFE_STORY_SLUG_RE.test(storySlug)) {
      return c.json({ error: 'Invalid story slug' }, 400)
    }

    try {
      const entity = await entityBySlug(storySlug)
      if (!entity) return c.json({ error: 'Story not found' }, 404)

      const limit = boundedInteger(c.req.query('limit'), DEFAULT_STORY_EVENT_LIMIT, 1, MAX_STORY_EVENT_LIMIT)
      const offset = boundedInteger(c.req.query('offset'), 0, 0, MAX_STORY_EVENT_OFFSET)
      const page = await memoryPage(entity.id, limit, offset)
      const story = storySummary(entity, page.latest ? [page.latest] : [], page.total)
      if (!story) return c.json({ error: 'Story not found' }, 404)

      const events: StoryEvent[] = page.memories.map((memory) => ({
        text: memory.summary,
        eventAt: memory.eventAt,
        imageUrl: memory.imageUrl,
        imageKind: memory.imageKind,
        imageAttribution: memory.imageAttribution,
      }))
      const nextOffset = offset + events.length
      const pagination: StoryPagination = {
        limit,
        offset,
        total: page.total,
        hasMore: nextOffset < page.total,
        nextOffset: nextOffset < page.total ? nextOffset : null,
      }
      return c.json({ story, events, pagination })
    } catch (error) {
      return storyError(c, error, 'GET /stories/:storySlug')
    }
  })

  return app
}

function selectedEntity(row: EntityRow | undefined): SelectedEntity | null {
  if (!row || typeof row.id !== 'string' || !UUID_RE.test(row.id)) return null
  if (typeof row.slug !== 'string' || !SAFE_STORY_SLUG_RE.test(row.slug)) return null
  if (typeof row.name !== 'string' || !row.name.trim()) return null
  return { id: row.id, slug: row.slug, name: row.name.trim(), type: null, imageUrl: null }
}

/** Atlas shelf: extends the validated legacy projection with the shelf type and card image. */
function atlasSelectedEntity(row: AtlasShelfRow | undefined): SelectedEntity | null {
  const entity = selectedEntity(row)
  if (!entity || !row) return null
  return {
    ...entity,
    type: atlasShelfType(row.type),
    imageUrl: atlasShelfImageUrl(row.image),
  }
}

/** Atlas shelf type: trimmed text; null when absent or blank. */
function atlasShelfType(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** Atlas card image: only a trimmed https: URL is accepted; empty, whitespace, http:, non-string or invalid URLs yield null. */
function atlasShelfImageUrl(value: unknown): string | null {
  const url = safeHttpUrl(value)
  return url !== null && new URL(url).protocol === 'https:' ? url : null
}

function storyMemory(row: EntityKnowledgeMemoryV1): StoryMemory | null {
  if (!UUID_RE.test(row.entityId) || !row.summary.trim() || !row.eventAt) return null
  if (!Number.isFinite(Date.parse(row.eventAt))) return null
  const image = storyImage(row.media)
  return {
    entityId: row.entityId,
    summary: row.summary.trim(),
    eventAt: row.eventAt,
    ...image,
  }
}

function atlasItemFilterParams(shelfId: string): URLSearchParams {
  return new URLSearchParams({
    select: ATLAS_ITEM_SELECT,
    main_shelf_id: `eq.${shelfId}`,
    status: 'eq.active',
    merged_into_id: 'is.null',
    occurred_at: 'not.is.null',
    order: 'occurred_at.desc,id.desc',
  })
}

function atlasItemParams(shelfId: string, limit: number, offset: number): URLSearchParams {
  const params = atlasItemFilterParams(shelfId)
  params.set('limit', String(limit))
  params.set('offset', String(offset))
  return params
}

function atlasMemory(row: AtlasItemRow | undefined, shelfId: string): StoryMemory | null {
  if (!row) return null
  const title = typeof row.title === 'string' ? row.title.trim() : ''
  const summary = typeof row.summary === 'string' && row.summary.trim() ? row.summary.trim() : title
  const occurredAt = typeof row.occurred_at === 'string' ? row.occurred_at : ''
  if (!summary || !occurredAt || !Number.isFinite(Date.parse(occurredAt))) return null
  return {
    entityId: shelfId,
    summary,
    eventAt: occurredAt,
    imageUrl: null,
    imageKind: null,
    imageAttribution: null,
  }
}

/** Parses the total out of a PostgREST Content-Range header, e.g. "0-0/42" or the empty-window "star-slash-total" form; null when absent/invalid. */
function contentRangeTotal(value: string | null): number | null {
  if (!value) return null
  const total = value.split('/')[1]
  if (!total || !/^\d+$/.test(total)) return null
  const parsed = Number(total)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

function storyImage(value: unknown): Pick<StoryMemory, 'imageUrl' | 'imageKind' | 'imageAttribution'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { imageUrl: null, imageKind: null, imageAttribution: null }
  }
  const context = value as Record<string, unknown>
  const imageUrl = safeHttpUrl(context.imageUrl)
  if (!imageUrl) {
    return { imageUrl: null, imageKind: null, imageAttribution: null }
  }
  const imageKind = context.imageKind === 'content' || context.imageKind === 'source_avatar'
    ? context.imageKind
    : new URL(imageUrl).pathname.includes('/profile_images/') ? 'source_avatar' : 'content'
  const imageAttribution = typeof context.attribution === 'string' && context.attribution.trim()
    ? context.attribution.trim()
    : null
  return { imageUrl, imageKind, imageAttribution }
}

function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = new URL(value.trim())
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? parsed.toString()
      : null
  } catch {
    return null
  }
}

/** Exposed for the #388 updatedAt guard tests. */
export function storySummary(entity: SelectedEntity, memories: StoryMemory[], eventCount = memories.length, now = Date.now()): StorySummary | null {
  // updatedAt tracks the newest memory that has already happened at request
  // time; a future-dated (scheduled) memory only wins when nothing has
  // happened yet, and then updatedAt is clamped to the request time.
  const reported = memories.filter((memory) => Date.parse(memory.eventAt) <= now)
  const latest = (reported.length ? reported : memories).reduce<StoryMemory | null>((current, memory) => (
    !current || Date.parse(memory.eventAt) > Date.parse(current.eventAt) ? memory : current
  ), null)
  if (!latest) return null
  // Atlas shelves carry their image on the selected entity and atlas memories
  // carry none; legacy Entities never carry one, so the shelf image (when
  // present) wins and legacy keeps the memory image untouched.
  const shelfImage = entity.imageUrl ?? null
  const imageUrl = shelfImage ?? latest.imageUrl
  return {
    storySlug: entity.slug,
    name: entity.name,
    latestDevelopment: latest.summary,
    eventCount,
    updatedAt: Date.parse(latest.eventAt) <= now ? latest.eventAt : new Date(now).toISOString(),
    imageUrl,
    imageKind: imageUrl ? (shelfImage ? 'content' : latest.imageKind) : null,
    imageAttribution: shelfImage ? null : latest.imageAttribution,
    shelfType: entity.type ?? null,
  }
}

function boundedInteger(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || !/^\d+$/.test(raw)) return fallback
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed)) return fallback
  return Math.min(Math.max(parsed, min), max)
}

function storyError(c: Context, error: unknown, label: string) {
  console.error(`[stories] ${label} failed`, error instanceof Error ? error.message : 'unknown error')
  return c.json({ error: 'Unable to load Stories' }, 500)
}
