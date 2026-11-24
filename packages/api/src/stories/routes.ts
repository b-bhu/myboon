import { Hono } from 'hono'
import type { Context } from 'hono'
import type { StoryMarket } from '@myboon/shared/stories'
import { createSupabaseRest } from '@myboon/shared/supabase-rest'
import type { HyperliquidQuoteMap, HyperliquidQuotes } from '../hyperliquid/prices.js'
import { hyperliquidDisplayName, hyperliquidDisplaySymbol } from '../hyperliquid/names.js'

// Atlas Feed: how many topics the stories list returns (two full 10-tile mosaic pages) (#797).
const MAX_ATLAS_STORIES = 20
// An entity is an Atlas Story when it has at least this many active, unmerged items in the window below.
const ATLAS_MIN_ITEMS = 3
const ATLAS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
// Bounded 7-day read: PostgREST pages of this size, at most this many pages (10k newest rows).
const ATLAS_WINDOW_PAGE_SIZE = 1000
const ATLAS_WINDOW_MAX_PAGES = 10
// Top-ranked eligible ids whose entity rows are fetched; spare room beyond the cap in case some are inactive or malformed.
const ATLAS_CANDIDATE_LIMIT = 40
const DEFAULT_STORY_EVENT_LIMIT = 20
const MAX_STORY_EVENT_LIMIT = 50
const MAX_STORY_EVENT_OFFSET = 10_000
const REQUEST_TIMEOUT_MS = 10_000
// #691: how long a quotes() call may wait for a price refresh before the list answers with what it has.
const MARKETS_QUOTES_WAIT_MS = 1500
const SAFE_STORY_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
// Atlas entities carry the story card image inside the jsonb `card` column
// (card.image = { url, source }); the PostgREST alias reads it as plain text.
const ATLAS_ENTITY_SELECT = 'id,slug,name,type,image:card->image->>url'
const ATLAS_ITEM_SELECT = 'id,title,summary,occurred_at'

interface EntityRow {
  id: unknown
  slug: unknown
  name: unknown
}

interface AtlasEntityRow extends EntityRow {
  type: unknown
  image: unknown
}

interface AtlasItemRow {
  id: unknown
  title: unknown
  summary: unknown
  occurred_at: unknown
}

interface AtlasWindowRow {
  main_entity_id: unknown
  occurred_at: unknown
}

interface SelectedEntity {
  id: string
  slug: string
  name: string
  /** Atlas entity type; null when absent. */
  type: string | null
  /** Atlas entity card image URL; null when absent. */
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
  /** Atlas entity type (lets the client pick a placeholder per type); null when absent. */
  entityType: string | null
  /**
   * Entity-linked Hyperliquid markets (#691), lead first. `storySummary()` keeps
   * it empty; the routes fill it from the `entity_markets` read (atlas source
   * only — the legacy source always sends an empty list).
   */
  markets: StoryMarket[]
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
  fetch?: typeof globalThis.fetch
  /** Clock for the Atlas 7-day window; defaults to Date.now. Tests inject it. */
  now?: () => number
  /** Hyperliquid price reader (#691); injected like `fetch` and `now`. Absent keeps links but sends null prices. */
  prices?: HyperliquidQuotes
}

/**
 * Public Story API. A Story is a deliberately selected Entity projected as a
 * minimal, chronological list of its public-safe Entity memory summaries.
 */
export function createStoryRoutes(config: StoryRoutesConfig): Hono {
  const app = new Hono()
  // Every Supabase read in this file goes through the one shared helper (#832).
  const rest = createSupabaseRest({
    supabaseUrl: config.supabaseUrl,
    serviceRoleKey: config.serviceRoleKey,
    ...(config.fetch ? { fetch: config.fetch } : {}),
    timeoutMs: REQUEST_TIMEOUT_MS,
  })

  /**
   * Atlas Stories pick themselves: entities with ATLAS_MIN_ITEMS+ active, unmerged
   * items dated inside the last 7 days, newest latest item first, capped at
   * MAX_ATLAS_STORIES. Counted here from one bounded read, no database view.
   */
  async function atlasSelectedEntities(): Promise<SelectedEntity[]> {
    const ranked = await atlasEligibleEntityIds()
    if (ranked.length === 0) return []
    const candidates = ranked.slice(0, ATLAS_CANDIDATE_LIMIT)
    const params = new URLSearchParams({
      select: ATLAS_ENTITY_SELECT,
      id: `in.(${candidates.join(',')})`,
      status: 'eq.active',
      limit: String(candidates.length),
    })
    const rows = await rest.readRows<AtlasEntityRow>('entities', params, 'atlas')
    const byId = new Map<string, SelectedEntity>()
    for (const row of rows) {
      const entity = atlasSelectedEntity(row)
      if (entity) byId.set(entity.id, entity)
    }
    return candidates.flatMap((id) => byId.get(id) ?? []).slice(0, MAX_ATLAS_STORIES)
  }

  /** Eligible entity ids (valid UUIDs), newest latest development first. */
  async function atlasEligibleEntityIds(): Promise<string[]> {
    const now = (config.now ?? Date.now)()
    const since = now - ATLAS_WINDOW_MS
    const stats = new Map<string, { count: number, latest: number }>()
    // Offset paging over a live table can skip or double-count a row if the entity
    // manager writes mid-read. Harmless for an eligibility threshold at 1-2 pages.
    for (let page = 0; page < ATLAS_WINDOW_MAX_PAGES; page += 1) {
      const rows = await rest.readRows<AtlasWindowRow>('entity_items', atlasWindowParams(since, now, page), 'atlas')
      if (rows.length === 0) break
      for (const row of rows) {
        if (typeof row.main_entity_id !== 'string' || !UUID_RE.test(row.main_entity_id)) continue
        const at = typeof row.occurred_at === 'string' ? Date.parse(row.occurred_at) : Number.NaN
        if (!Number.isFinite(at) || at < since || at > now) continue
        const stat = stats.get(row.main_entity_id)
        if (stat) {
          stat.count += 1
          if (at > stat.latest) stat.latest = at
        } else {
          stats.set(row.main_entity_id, { count: 1, latest: at })
        }
      }
      if (rows.length < ATLAS_WINDOW_PAGE_SIZE) break
      if (page === ATLAS_WINDOW_MAX_PAGES - 1) {
        console.warn('[stories] Atlas 7-day window hit the page cap; counts use the newest rows only')
      }
    }
    return [...stats.entries()]
      .filter(([, stat]) => stat.count >= ATLAS_MIN_ITEMS)
      .sort(([idA, a], [idB, b]) => b.latest - a.latest || (idA < idB ? -1 : idA > idB ? 1 : 0))
      .map(([id]) => id)
  }

  async function atlasSelectedEntityBySlug(storySlug: string): Promise<SelectedEntity | null> {
    // No eligibility or carousel-flag gate: an entity that dropped out of the
    // list still opens as long as it is active (the route 404s if it has no items).
    const params = new URLSearchParams({
      select: ATLAS_ENTITY_SELECT,
      slug: `eq.${storySlug}`,
      status: 'eq.active',
      limit: '1',
    })
    const rows = await rest.readRows<AtlasEntityRow>('entities', params, 'atlas')
    return atlasSelectedEntity(rows[0])
  }

  async function atlasItemsTotal(entityId: string): Promise<number> {
    // Count read: PostgREST answers with the total in Content-Range, not the rows.
    return rest.readCount('entity_items', atlasItemFilterParams(entityId), 'atlas')
  }

  async function atlasStoryMemories(entityIds: string[]): Promise<{
    memoriesByEntity: Map<string, StoryMemory[]>,
    totalsByEntity: Map<string, number>,
  }> {
    const grouped = new Map<string, StoryMemory[]>()
    const totals = new Map<string, number>()
    if (entityIds.length === 0) return { memoriesByEntity: grouped, totalsByEntity: totals }
    await Promise.all(entityIds.filter((entityId) => UUID_RE.test(entityId)).map(async (entityId) => {
      const [latestRows, total] = await Promise.all([
        rest.readRows<AtlasItemRow>('entity_items', atlasItemParams(entityId, 1, 0), 'atlas'),
        atlasItemsTotal(entityId),
      ])
      const expected = total > 0 ? 1 : 0
      const memory = atlasMemory(latestRows[0], entityId)
      if (latestRows.length !== expected || (expected === 1 && (!memory || memory.entityId !== entityId))) {
        throw new Error('Atlas item page was incomplete')
      }
      if (memory) grouped.set(entityId, [memory])
      totals.set(entityId, total)
    }))
    return { memoriesByEntity: grouped, totalsByEntity: totals }
  }

  async function atlasItemPage(entityId: string, limit: number, offset: number): Promise<{
    memories: StoryMemory[]
    total: number
    latest: StoryMemory | null
  }> {
    if (!UUID_RE.test(entityId)) return { memories: [], total: 0, latest: null }
    const [rows, total] = await Promise.all([
      rest.readRows<AtlasItemRow>('entity_items', atlasItemParams(entityId, limit, offset), 'atlas'),
      atlasItemsTotal(entityId),
    ])
    const memories: StoryMemory[] = []
    for (const row of rows) {
      const memory = atlasMemory(row, entityId)
      if (!memory || memory.entityId !== entityId) throw new Error('Atlas item page was incomplete')
      memories.push(memory)
    }
    const expected = Math.min(limit, Math.max(0, total - offset))
    if (memories.length !== expected) throw new Error('Atlas item page was incomplete')
    let latest: StoryMemory | null = null
    if (total > 0) {
      if (offset === 0) {
        latest = memories[0] ?? null
      } else {
        const latestRows = await rest.readRows<AtlasItemRow>('entity_items', atlasItemParams(entityId, 1, 0), 'atlas')
        latest = atlasMemory(latestRows[0], entityId)
      }
      if (!latest) throw new Error('Atlas item page was incomplete')
    }
    return { memories, total, latest }
  }

  const listEntities = atlasSelectedEntities
  const listMemories = atlasStoryMemories
  const entityBySlug = atlasSelectedEntityBySlug
  const memoryPage = atlasItemPage

  interface EntityMarketRow {
    entity_id: unknown
    rank: unknown
    symbol: unknown
  }

  interface EntityMarketLink {
    entityId: string
    rank: 1 | 2 | 3
    symbol: string
  }

  /** One PostgREST read of the atlas entity_markets links for the listed entity ids (#691). */
  function entityMarketsParams(entityIds: string[]): URLSearchParams {
    return new URLSearchParams({
      select: 'entity_id,rank,symbol',
      entity_id: `in.(${entityIds.join(',')})`,
      order: 'entity_id.asc,rank.asc',
    })
  }

  /**
   * Atlas source only: reads the 0-3 market links per listed entity. A failed
   * read is contained — logged once and answered with no links, so /stories
   * still returns 200 and every story keeps its `markets`, just empty (`[]`).
   */
  async function entityMarketLinks(entityIds: string[]): Promise<Map<string, EntityMarketLink[]>> {
    const linksByEntity = new Map<string, EntityMarketLink[]>()
    try {
      if (entityIds.length === 0) return linksByEntity
      const rows = await rest.readRows<EntityMarketRow>('entity_markets', entityMarketsParams(entityIds), 'atlas')
      for (const row of rows) {
        const entityId = row.entity_id
        const rank = row.rank
        const symbol = row.symbol
        if (typeof entityId !== 'string' || !entityIds.includes(entityId)) continue
        if (rank !== 1 && rank !== 2 && rank !== 3) continue
        if (typeof symbol !== 'string' || !symbol) continue
        const links = linksByEntity.get(entityId) ?? []
        if (links.some((link) => link.symbol === symbol)) continue
        links.push({ entityId, rank, symbol })
        linksByEntity.set(entityId, links)
      }
    } catch (error) {
      console.error('[stories] entity_markets read failed', error instanceof Error ? error.message : 'unknown error')
      return new Map()
    }
    // The table is unique per (entity_id, rank); keep the lead-first order defensively, capped at 3.
    for (const [entityId, links] of linksByEntity) {
      links.sort((left, right) => left.rank - right.rank || (left.symbol < right.symbol ? -1 : left.symbol > right.symbol ? 1 : 0))
      linksByEntity.set(entityId, links.slice(0, 3))
    }
    return linksByEntity
  }

  /**
   * Builds each story's `markets` in rank order: one `quotes` call per request
   * for every linked symbol together, capped at MARKETS_QUOTES_WAIT_MS even
   * when an injected prices never settles. Links are never hidden by price
   * state — a missing or unpriced symbol keeps the link with null prices.
   */
  async function storyMarkets(linksByEntity: Map<string, EntityMarketLink[]>): Promise<Map<string, StoryMarket[]>> {
    if (linksByEntity.size === 0) return new Map()
    const symbols = [...new Set([...linksByEntity.values()].flat().map((link) => link.symbol))]
    let quoteMap: HyperliquidQuoteMap | null = null
    if (config.prices && symbols.length > 0) {
      quoteMap = await quotesWithinCap(symbols)
    }
    const marketsByEntity = new Map<string, StoryMarket[]>()
    for (const [entityId, links] of linksByEntity) {
      marketsByEntity.set(entityId, links.map((link) => {
        const quote = quoteMap instanceof Map ? quoteMap.get(link.symbol) : null
        return {
          symbol: link.symbol,
          displaySymbol: hyperliquidDisplaySymbol(link.symbol),
          displayName: hyperliquidDisplayName(link.symbol),
          rank: link.rank,
          price: quote?.price ?? null,
          change24hPct: quote?.change24hPct ?? null,
          asOf: quote?.asOf ?? null,
        }
      }))
    }
    return marketsByEntity
  }

  async function quotesWithinCap(symbols: string[]): Promise<HyperliquidQuoteMap | null> {
    let timerHandle: ReturnType<typeof setTimeout> | undefined
    const guard = new Promise<null>((resolve) => {
      timerHandle = setTimeout(() => resolve(null), MARKETS_QUOTES_WAIT_MS)
    })
    const raced = await Promise.race([
      config.prices!.quotes(symbols, { waitMs: MARKETS_QUOTES_WAIT_MS }).then(
        (value) => (value instanceof Map ? value : null),
        () => null,
      ),
      guard,
    ])
    if (timerHandle) clearTimeout(timerHandle)
    return raced
  }

  app.get('/', async (c) => {
    try {
      const entities = await listEntities()
      const { memoriesByEntity, totalsByEntity } = await listMemories(entities.map((entity) => entity.id))
      const marketsByEntity = await storyMarkets(await entityMarketLinks(entities.map((entity) => entity.id)))
      const stories = entities.flatMap((entity) => {
        const memories = memoriesByEntity.get(entity.id) ?? []
        const story = storySummary(entity, memories, totalsByEntity.get(entity.id) ?? memories.length)
        if (!story) return []
        return [{ ...story, markets: marketsByEntity.get(entity.id) ?? [] }]
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
      const marketsByEntity = await storyMarkets(await entityMarketLinks([entity.id]))

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
      return c.json({ story: { ...story, markets: marketsByEntity.get(entity.id) ?? [] }, events, pagination })
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

/** Atlas entity: extends the validated base projection with the entity type and card image. */
function atlasSelectedEntity(row: AtlasEntityRow | undefined): SelectedEntity | null {
  const entity = selectedEntity(row)
  if (!entity || !row) return null
  return {
    ...entity,
    type: atlasEntityType(row.type),
    imageUrl: atlasEntityImageUrl(row.image),
  }
}

/** Atlas entity type: trimmed text; null when absent or blank. */
function atlasEntityType(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** Atlas card image: only a trimmed https: URL is accepted; empty, whitespace, http:, non-string or invalid URLs yield null. */
function atlasEntityImageUrl(value: unknown): string | null {
  const url = safeHttpUrl(value)
  return url !== null && new URL(url).protocol === 'https:' ? url : null
}

function atlasItemFilterParams(entityId: string): URLSearchParams {
  return new URLSearchParams({
    select: ATLAS_ITEM_SELECT,
    main_entity_id: `eq.${entityId}`,
    status: 'eq.active',
    merged_into_id: 'is.null',
    occurred_at: 'not.is.null',
    order: 'occurred_at.desc,id.desc',
  })
}

/** Page `page` of the bounded 7-day window read: same item filter as the endpoint, plus occurred_at in [since, now]. */
function atlasWindowParams(since: number, now: number, page: number): URLSearchParams {
  const params = new URLSearchParams({
    select: 'main_entity_id,occurred_at',
    status: 'eq.active',
    merged_into_id: 'is.null',
    main_entity_id: 'not.is.null',
    order: 'occurred_at.desc,id.desc',
    limit: String(ATLAS_WINDOW_PAGE_SIZE),
    offset: String(page * ATLAS_WINDOW_PAGE_SIZE),
  })
  params.append('occurred_at', `gte.${new Date(since).toISOString()}`)
  params.append('occurred_at', `lte.${new Date(now).toISOString()}`)
  return params
}

function atlasItemParams(entityId: string, limit: number, offset: number): URLSearchParams {
  const params = atlasItemFilterParams(entityId)
  params.set('limit', String(limit))
  params.set('offset', String(offset))
  return params
}

function atlasMemory(row: AtlasItemRow | undefined, entityId: string): StoryMemory | null {
  if (!row) return null
  const title = typeof row.title === 'string' ? row.title.trim() : ''
  const summary = typeof row.summary === 'string' && row.summary.trim() ? row.summary.trim() : title
  const occurredAt = typeof row.occurred_at === 'string' ? row.occurred_at : ''
  if (!summary || !occurredAt || !Number.isFinite(Date.parse(occurredAt))) return null
  return {
    entityId,
    summary,
    eventAt: occurredAt,
    imageUrl: null,
    imageKind: null,
    imageAttribution: null,
  }
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
  // Atlas entities carry their image on the selected entity and atlas memories
  // carry none, so the entity image (when present) wins.
  const entityImage = entity.imageUrl ?? null
  const imageUrl = entityImage ?? latest.imageUrl
  return {
    storySlug: entity.slug,
    name: entity.name,
    latestDevelopment: latest.summary,
    eventCount,
    updatedAt: Date.parse(latest.eventAt) <= now ? latest.eventAt : new Date(now).toISOString(),
    imageUrl,
    imageKind: imageUrl ? (entityImage ? 'content' : latest.imageKind) : null,
    imageAttribution: entityImage ? null : latest.imageAttribution,
    entityType: entity.type ?? null,
    markets: [],
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
