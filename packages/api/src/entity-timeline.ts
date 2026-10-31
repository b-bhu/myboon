import { Hono } from 'hono'

// #505 entity timeline: GET /entities/:slug/timeline returns one atlas entity's active items
// (angle, note, signal link, time) and its stories, newest first. Read-only PostgREST (atlas
// profile): the entity is looked up first (404 when unknown), then items and stories in parallel.
// Any Supabase failure is a 502 without upstream detail, so the service key never leaks.

const REQUEST_TIMEOUT_MS = 10_000
const MAX_ITEMS = 50
const MAX_STORIES = 20
// Same slug shape as the stories routes.
const SAFE_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/
const ENTITY_SELECT = 'id,slug,name,type'
const ITEM_SELECT = 'id,title,angle,note,occurred_at,created_at,signal:signals(link)'
const STORY_SELECT = 'id,slug,title,summary,status,created_at,updated_at,story_items(item_id)'

interface EntityRow {
  id: unknown
  slug: unknown
  name: unknown
  type: unknown
}

interface ItemRow {
  id: unknown
  title: unknown
  angle: unknown
  note: unknown
  occurred_at: unknown
  signal: unknown
}

interface StoryRow {
  id: unknown
  slug: unknown
  title: unknown
  summary: unknown
  status: unknown
  created_at: unknown
  updated_at: unknown
  story_items: unknown
}

export interface EntityTimelineRoutesConfig {
  supabaseUrl: string
  serviceRoleKey: string
  /** Injectable for tests; defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch
}

export function createEntityTimelineRoutes(config: EntityTimelineRoutesConfig): Hono {
  const app = new Hono()
  const fetchImpl = config.fetch ?? globalThis.fetch
  const restBaseUrl = `${config.supabaseUrl.replace(/\/$/, '')}/rest/v1`

  function restHeaders(): Record<string, string> {
    return {
      apikey: config.serviceRoleKey,
      Authorization: `Bearer ${config.serviceRoleKey}`,
      Accept: 'application/json',
      'Accept-Profile': 'atlas',
    }
  }

  async function readRows<T>(table: string, params: URLSearchParams): Promise<T[]> {
    const response = await fetchImpl(`${restBaseUrl}/${table}?${params}`, {
      headers: restHeaders(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) {
      throw new Error(`Supabase read failed for ${table}: ${response.status}`)
    }
    const body: unknown = await response.json()
    if (!Array.isArray(body)) throw new Error(`Supabase returned an invalid ${table} response`)
    return body as T[]
  }

  app.get('/:slug/timeline', async (c) => {
    const slug = c.req.param('slug')
    if (!SAFE_SLUG_RE.test(slug)) {
      return c.json({ error: 'Invalid entity slug' }, 400)
    }

    try {
      const entities = await readRows<EntityRow>('entities', new URLSearchParams({
        select: ENTITY_SELECT,
        slug: `eq.${slug}`,
        limit: '1',
      }))
      const entity = entities[0]
      if (!entity || typeof entity.id !== 'string' || !entity.id) {
        return c.json({ error: 'Entity not found' }, 404)
      }

      const [items, stories] = await Promise.all([
        readRows<ItemRow>('entity_items', new URLSearchParams({
          select: ITEM_SELECT,
          main_entity_id: `eq.${entity.id}`,
          status: 'eq.active',
          order: 'occurred_at.desc.nullslast,created_at.desc',
          limit: String(MAX_ITEMS),
        })),
        readRows<StoryRow>('stories', new URLSearchParams({
          select: STORY_SELECT,
          entity_id: `eq.${entity.id}`,
          order: 'updated_at.desc',
          limit: String(MAX_STORIES),
        })),
      ])
      return c.json({
        entity: { slug: entity.slug, name: entity.name, type: entity.type },
        items: items.map(itemTimeline),
        stories: stories.map(storyTimeline),
      })
    } catch (error) {
      console.error('[entity-timeline] read failed:', error instanceof Error ? error.message : error)
      return c.json({ error: 'upstream_failed' }, 502)
    }
  })

  return app
}

function itemTimeline(row: ItemRow) {
  const signal = row.signal !== null && typeof row.signal === 'object' && !Array.isArray(row.signal)
    ? row.signal as { link?: unknown }
    : null
  return {
    id: row.id,
    title: row.title,
    angle: row.angle,
    note: row.note,
    signalLink: typeof signal?.link === 'string' ? signal.link : null,
    occurredAt: row.occurred_at,
  }
}

function storyTimeline(row: StoryRow) {
  const links = Array.isArray(row.story_items) ? row.story_items : []
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    status: row.status,
    itemIds: links.map((link) => (link as { item_id: unknown }).item_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}