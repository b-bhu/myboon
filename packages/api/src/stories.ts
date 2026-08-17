import { Hono } from 'hono'
import type { Context } from 'hono'

const MAX_STORIES = 5
const REQUEST_TIMEOUT_MS = 10_000
const SAFE_STORY_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ENTITY_SELECT = 'id,slug,name'
const MEMORY_SELECT = 'entity_id,memory_type,summary,event_at,context'

interface EntityRow {
  id: unknown
  slug: unknown
  name: unknown
}

interface MemoryRow {
  entity_id: unknown
  memory_type: unknown
  summary: unknown
  event_at: unknown
  context: unknown
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

export interface StoryRoutesConfig {
  supabaseUrl: string
  serviceRoleKey: string
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

  async function storyMemories(entityIds: string[]): Promise<Map<string, StoryMemory[]>> {
    const grouped = new Map<string, StoryMemory[]>()
    if (entityIds.length === 0) return grouped

    const safeIds = entityIds.filter((id) => UUID_RE.test(id))
    if (safeIds.length === 0) return grouped

    const params = new URLSearchParams({
      select: MEMORY_SELECT,
      entity_id: `in.(${safeIds.join(',')})`,
      memory_type: 'neq.source_marker',
      event_at: 'not.is.null',
      order: 'event_at.asc',
    })
    const rows = await readRows<MemoryRow>('entity_memories', params)
    const allowedEntityIds = new Set(safeIds)

    for (const row of rows) {
      const memory = storyMemory(row)
      if (!memory || !allowedEntityIds.has(memory.entityId)) continue
      const entityMemories = grouped.get(memory.entityId) ?? []
      entityMemories.push(memory)
      grouped.set(memory.entityId, entityMemories)
    }

    for (const memories of grouped.values()) {
      memories.sort((left, right) => Date.parse(left.eventAt) - Date.parse(right.eventAt))
    }
    return grouped
  }

  app.get('/', async (c) => {
    try {
      const entities = await selectedEntities()
      const memoriesByEntity = await storyMemories(entities.map((entity) => entity.id))
      const stories = entities.flatMap((entity) => {
        const memories = memoriesByEntity.get(entity.id) ?? []
        const story = storySummary(entity, memories)
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

      const memories = (await storyMemories([entity.id])).get(entity.id) ?? []
      const story = storySummary(entity, memories)
      if (!story) return c.json({ error: 'Story not found' }, 404)

      const events: StoryEvent[] = memories.map((memory) => ({
        text: memory.summary,
        eventAt: memory.eventAt,
        imageUrl: memory.imageUrl,
        imageKind: memory.imageKind,
        imageAttribution: memory.imageAttribution,
      }))
      return c.json({ story, events })
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

function storyMemory(row: MemoryRow): StoryMemory | null {
  if (row.memory_type === 'source_marker') return null
  if (typeof row.entity_id !== 'string' || !UUID_RE.test(row.entity_id)) return null
  if (typeof row.summary !== 'string' || !row.summary.trim()) return null
  if (typeof row.event_at !== 'string' || !row.event_at.trim()) return null
  if (!Number.isFinite(Date.parse(row.event_at))) return null
  const image = storyImage(row.context)
  return {
    entityId: row.entity_id,
    summary: row.summary.trim(),
    eventAt: row.event_at,
    ...image,
  }
}

function storyImage(value: unknown): Pick<StoryMemory, 'imageUrl' | 'imageKind' | 'imageAttribution'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { imageUrl: null, imageKind: null, imageAttribution: null }
  }
  const context = value as Record<string, unknown>
  const imageUrl = safeHttpUrl(context.image_url)
  if (!imageUrl) {
    return { imageUrl: null, imageKind: null, imageAttribution: null }
  }
  const imageKind = context.image_kind === 'content' || context.image_kind === 'source_avatar'
    ? context.image_kind
    : new URL(imageUrl).pathname.includes('/profile_images/') ? 'source_avatar' : 'content'
  const imageAttribution = typeof context.image_attribution === 'string' && context.image_attribution.trim()
    ? context.image_attribution.trim()
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

function storySummary(entity: SelectedEntity, memories: StoryMemory[]): StorySummary | null {
  const latest = memories.at(-1)
  if (!latest) return null
  return {
    storySlug: entity.slug,
    name: entity.name,
    latestDevelopment: latest.summary,
    eventCount: memories.length,
    updatedAt: latest.eventAt,
    imageUrl: latest.imageUrl,
    imageKind: latest.imageKind,
    imageAttribution: latest.imageAttribution,
  }
}

function storyError(c: Context, error: unknown, label: string) {
  console.error(`[stories] ${label} failed`, error instanceof Error ? error.message : 'unknown error')
  return c.json({ error: 'Unable to load Stories' }, 500)
}
