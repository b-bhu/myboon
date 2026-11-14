import { Hono } from 'hono'
import type { Context } from 'hono'
import type { LatestUpdate, LatestUpdateSource, LatestUpdatesResponse } from '@myboon/shared/latest-updates'

/**
 * Public read of the latest updates written by the myboon-latest-updates job (#623, D2 #633).
 *
 * Read-only: GET requests to PostgREST only, as service_role (SELECT on
 * atlas.latest_updates and atlas.latest_update_items from #630, plus the existing Atlas reads
 * Stories already use). Visibility is set at insert by the worker, so this route only filters
 * `visibility = 'live'` and never changes a row. `claims`, `model`, `run_id` and `visibility`
 * are never returned.
 */

export const LATEST_UPDATES_DEFAULT_LIMIT = 12
export const LATEST_UPDATES_MAX_LIMIT = 30

const REQUEST_TIMEOUT_MS = 10_000
// Live rows are read newest first in pages and reduced to the newest row per entity in code
// (PostgREST has no DISTINCT ON). Bounded: at most this many pages of this many rows.
const UPDATE_PAGE_SIZE = 100
const UPDATE_MAX_PAGES = 5
// Rows per `in.(...)` read, so a request URL stays short.
const UUID_CHUNK = 50
const SIGNAL_CHUNK = 25
const ITEMS_ROW_LIMIT = 1000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SIGNAL_ID_RE = /^[0-9a-f]{64}$/i

const UPDATE_SELECT = 'id,entity_id,headline,what_happened,how_we_got_here,what_to_watch,published_at,visibility'

export interface LatestUpdateRoutesConfig {
  supabaseUrl: string
  serviceRoleKey: string
  fetch?: typeof globalThis.fetch
}

interface UpdateRow {
  id: unknown
  entity_id: unknown
  headline: unknown
  what_happened: unknown
  how_we_got_here: unknown
  what_to_watch: unknown
  published_at: unknown
  visibility: unknown
}

interface EntityRow { id: unknown, slug: unknown, name: unknown, type: unknown, status: unknown }
interface EntityInfo { slug: string, name: string, type: string }
interface UpdateItemRow { latest_update_id: unknown, entity_item_id: unknown }
interface ItemRow { id: unknown, title: unknown, occurred_at: unknown, signal_id: unknown }
interface ItemSignalRow { item_id: unknown, signal_id: unknown }
interface SignalRow { signal_id: unknown, link: unknown }

interface ValidUpdate {
  id: string
  entityId: string
  headline: string
  whatHappened: string
  howWeGotHere: string
  whatToWatch: string
  publishedAt: string
}

export function createLatestUpdateRoutes(config: LatestUpdateRoutesConfig): Hono {
  const app = new Hono()
  const fetchImpl = config.fetch ?? globalThis.fetch
  const restBaseUrl = `${config.supabaseUrl.replace(/\/$/, '')}/rest/v1`

  async function readRows<T>(table: string, params: URLSearchParams): Promise<T[]> {
    const url = new URL(`${restBaseUrl}/${table}`)
    params.forEach((value, key) => url.searchParams.append(key, value))
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
        Accept: 'application/json',
        'Accept-Profile': 'atlas',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`Supabase read failed for ${table}: ${response.status}`)
    const body: unknown = await response.json()
    if (!Array.isArray(body)) throw new Error(`Supabase returned an invalid ${table} response`)
    return body as T[]
  }

  /** `in.(...)` reads in parallel chunks; any failed chunk fails the whole read (no partial data). */
  async function readIn<T>(table: string, column: string, values: string[], chunk: number, extra: Record<string, string>): Promise<T[]> {
    const groups: string[][] = []
    for (let i = 0; i < values.length; i += chunk) groups.push(values.slice(i, i + chunk))
    const pages = await Promise.all(groups.map((group) => readRows<T>(table, new URLSearchParams({
      ...extra,
      [column]: `in.(${group.join(',')})`,
    }))))
    return pages.flat()
  }

  /**
   * Newest live row per ACTIVE entity, newest first, at most `limit`. Inactive entities are hidden
   * here, before the limit, so they never use up a slot. Returns the active entities it read.
   */
  async function newestLivePerActiveEntity(limit: number): Promise<{ picked: ValidUpdate[], entities: Map<string, EntityInfo> }> {
    const picked: ValidUpdate[] = []
    const entities = new Map<string, EntityInfo>()
    const seen = new Set<string>()
    for (let page = 0; page < UPDATE_MAX_PAGES && picked.length < limit; page += 1) {
      const rows = await readRows<UpdateRow>('latest_updates', new URLSearchParams({
        select: UPDATE_SELECT,
        visibility: 'eq.live',
        order: 'published_at.desc,id.desc',
        limit: String(UPDATE_PAGE_SIZE),
        offset: String(page * UPDATE_PAGE_SIZE),
      }))
      const candidates: ValidUpdate[] = []
      for (const row of rows) {
        // Defence in depth: the filter above already excludes dark rows.
        if (row.visibility !== 'live') continue
        const update = validUpdate(row)
        if (!update || seen.has(update.entityId)) continue
        seen.add(update.entityId)
        candidates.push(update)
      }
      if (candidates.length > 0) {
        const entityRows = await readIn<EntityRow>('entities', 'id', candidates.map((u) => u.entityId), UUID_CHUNK, {
          select: 'id,slug,name,type,status',
          status: 'eq.active',
        })
        for (const row of entityRows) {
          // Defence in depth: the filter above already excludes inactive entities.
          if (row.status !== 'active') continue
          if (isUuid(row.id) && nonEmpty(row.slug) && nonEmpty(row.name) && nonEmpty(row.type)) {
            entities.set(row.id, { slug: row.slug, name: row.name, type: row.type })
          }
        }
        for (const update of candidates) {
          if (picked.length >= limit) break
          if (entities.has(update.entityId)) picked.push(update)
        }
      }
      if (rows.length < UPDATE_PAGE_SIZE) break
    }
    return { picked, entities }
  }

  async function load(limit: number): Promise<LatestUpdatesResponse> {
    const { picked: updates, entities } = await newestLivePerActiveEntity(limit)
    if (updates.length === 0) return { updates: [] }

    const updateItemRows = await readIn<UpdateItemRow>('latest_update_items', 'latest_update_id', updates.map((u) => u.id), UUID_CHUNK, {
      select: 'latest_update_id,entity_item_id',
      limit: String(ITEMS_ROW_LIMIT),
    })
    const itemIdsByUpdate = new Map<string, string[]>()
    for (const row of updateItemRows) {
      if (!isUuid(row.latest_update_id) || !isUuid(row.entity_item_id)) continue
      const list = itemIdsByUpdate.get(row.latest_update_id) ?? []
      list.push(row.entity_item_id)
      itemIdsByUpdate.set(row.latest_update_id, list)
    }

    const itemIds = [...new Set([...itemIdsByUpdate.values()].flat())]
    const items = new Map<string, { title: string, occurredAt: string, signalId: string | null }>()
    const originSignalIds = new Map<string, string[]>()
    if (itemIds.length > 0) {
      const [itemRows, originRows] = await Promise.all([
        readIn<ItemRow>('entity_items', 'id', itemIds, UUID_CHUNK, { select: 'id,title,occurred_at,signal_id' }),
        readIn<ItemSignalRow>('item_signals', 'item_id', itemIds, UUID_CHUNK, {
          select: 'item_id,signal_id',
          role: 'eq.origin',
          limit: String(ITEMS_ROW_LIMIT),
        }),
      ])
      for (const row of itemRows) {
        if (!isUuid(row.id) || !nonEmpty(row.title) || !isIsoTime(row.occurred_at)) continue
        items.set(row.id, {
          title: row.title,
          occurredAt: row.occurred_at,
          signalId: typeof row.signal_id === 'string' && SIGNAL_ID_RE.test(row.signal_id) ? row.signal_id : null,
        })
      }
      for (const row of originRows) {
        if (!isUuid(row.item_id) || typeof row.signal_id !== 'string' || !SIGNAL_ID_RE.test(row.signal_id)) continue
        const list = originSignalIds.get(row.item_id) ?? []
        list.push(row.signal_id)
        originSignalIds.set(row.item_id, list)
      }
    }

    const wantedSignals = new Set<string>()
    for (const [itemId, item] of items) {
      for (const id of originSignalIds.get(itemId) ?? []) wantedSignals.add(id)
      if (item.signalId) wantedSignals.add(item.signalId)
    }
    const links = new Map<string, string>()
    if (wantedSignals.size > 0) {
      const signalRows = await readIn<SignalRow>('signals', 'signal_id', [...wantedSignals], SIGNAL_CHUNK, { select: 'signal_id,link' })
      for (const row of signalRows) {
        const link = safeHttpUrl(row.link)
        if (typeof row.signal_id === 'string' && link) links.set(row.signal_id, link)
      }
    }

    const out: LatestUpdate[] = []
    for (const update of updates) {
      const entity = entities.get(update.entityId)
      if (!entity) continue
      const sources: LatestUpdateSource[] = []
      for (const itemId of new Set(itemIdsByUpdate.get(update.id) ?? [])) {
        const item = items.get(itemId)
        if (!item) continue
        // The origin signal link: item_signals role=origin first (stable order), else the item's own signal.
        const candidates = [...(originSignalIds.get(itemId) ?? []).sort(), ...(item.signalId ? [item.signalId] : [])]
        const link = candidates.map((id) => links.get(id)).find((value): value is string => value !== undefined)
        if (!link) continue
        sources.push({ itemId, title: item.title, link, occurredAt: item.occurredAt })
      }
      sources.sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt) || (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0))
      out.push({
        id: update.id,
        entitySlug: entity.slug,
        entityName: entity.name,
        entityType: entity.type,
        headline: update.headline,
        whatHappened: update.whatHappened,
        howWeGotHere: update.howWeGotHere,
        whatToWatch: update.whatToWatch,
        sources,
        publishedAt: update.publishedAt,
      })
    }
    return { updates: out }
  }

  app.get('/', async (c) => {
    const limit = boundedInteger(c.req.query('limit'), LATEST_UPDATES_DEFAULT_LIMIT, 1, LATEST_UPDATES_MAX_LIMIT)
    try {
      return c.json(await load(limit))
    } catch (error) {
      return latestUpdatesError(c, error)
    }
  })

  return app
}

function validUpdate(row: UpdateRow): ValidUpdate | null {
  if (
    !isUuid(row.id) || !isUuid(row.entity_id)
    || !nonEmpty(row.headline) || !nonEmpty(row.what_happened)
    || !nonEmpty(row.how_we_got_here) || !nonEmpty(row.what_to_watch)
    || !isIsoTime(row.published_at)
  ) return null
  return {
    id: row.id,
    entityId: row.entity_id,
    headline: row.headline,
    whatHappened: row.what_happened,
    howWeGotHere: row.how_we_got_here,
    whatToWatch: row.what_to_watch,
    publishedAt: row.published_at,
  }
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isIsoTime(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = new URL(value.trim())
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null
  } catch {
    return null
  }
}

/** Missing or non-numeric: the fallback. Numeric: clamped to min..max (0 becomes 1, 99 becomes 30). */
function boundedInteger(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || !/^\d+$/.test(raw)) return fallback
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed)) return fallback
  return Math.min(Math.max(parsed, min), max)
}

function latestUpdatesError(c: Context, error: unknown) {
  console.error('[latest-updates] read failed', error instanceof Error ? error.message : 'unknown error')
  return c.json({ error: 'Unable to load latest updates' }, 500)
}
