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
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ENTITY_SELECT = 'id,slug,name'

interface EntityRow {
  id: unknown
  slug: unknown
  name: unknown
}

interface SelectedEntity {
  id: string
  slug: string
  name: string
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

  async function readRows<T>(table: string, params: URLSearchParams): Promise<T[]> {
    const url = new URL(`${restBaseUrl}/${table}`)
    params.forEach((value, key) => url.searchParams.append(key, value))
    const response = await fetchImpl(url, {
      headers: {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
        Accept: 'application/json',
      },
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

  app.get('/', async (c) => {
    try {
      const entities = await selectedEntities()
      const { memoriesByEntity, totalsByEntity } = await storyMemories(entities.map((entity) => entity.id))
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
      const entity = await selectedEntityBySlug(storySlug)
      if (!entity) return c.json({ error: 'Story not found' }, 404)

      const limit = boundedInteger(c.req.query('limit'), DEFAULT_STORY_EVENT_LIMIT, 1, MAX_STORY_EVENT_LIMIT)
      const offset = boundedInteger(c.req.query('offset'), 0, 0, MAX_STORY_EVENT_OFFSET)
      const page = await storyMemoryPage(entity.id, limit, offset)
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
  return { id: row.id, slug: row.slug, name: row.name.trim() }
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

function storySummary(entity: SelectedEntity, memories: StoryMemory[], eventCount = memories.length): StorySummary | null {
  const latest = memories.reduce<StoryMemory | null>((current, memory) => (
    !current || Date.parse(memory.eventAt) > Date.parse(current.eventAt) ? memory : current
  ), null)
  if (!latest) return null
  return {
    storySlug: entity.slug,
    name: entity.name,
    latestDevelopment: latest.summary,
    eventCount,
    updatedAt: latest.eventAt,
    imageUrl: latest.imageUrl,
    imageKind: latest.imageKind,
    imageAttribution: latest.imageAttribution,
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
