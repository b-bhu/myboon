import { Hono } from 'hono'
import type { Context } from 'hono'
import { timingSafeEqual } from 'node:crypto'

/**
 * Read-only browse routes over the atlas PostgREST schema for the internal
 * dashboard (#552): scout signals, analyst decisions, entities, entity items.
 * Plain fetch, no supabase-js — same pattern as internal/entities.ts and
 * stories.ts (service-role headers plus the atlas Accept-Profile).
 */

interface InternalAtlasBrowseRoutesConfig {
  supabaseUrl: string
  serviceRoleKey: string
  internalToken?: string
  fetchImpl?: typeof fetch
  now?: () => Date
}

type Row = Record<string, unknown>

interface ParsedTime {
  iso: string
  ms: number
}

interface CursorKey {
  /** Sort timestamp of the last row on the returned page. */
  t: string
  /** Sort id of the last row on the returned page. */
  id: string
}

interface ParsedListQuery {
  filters: URLSearchParams
  limit: number
  cursor?: CursorKey
  /** /entity-items only: the entity slug to resolve to a main_entity_id before reading. */
  entitySlug?: string
}

type ParseResult =
  | { ok: true; query: ParsedListQuery }
  | { ok: false; error: string }

interface ListSpec {
  /** Route label for error logs. */
  route: string
  table: string
  select: string
  order: string
  /** Timestamp column driving the sort and the keyset cursor. */
  sortColumn: string
  idColumn: string
  responseKey: string
  mapRow?: (row: Row) => Row
}

const SIGNALS: ListSpec = {
  route: 'GET /internal/atlas/signals',
  table: 'signals',
  select: 'signal_id,source,source_id,type,status,priority,occurred_at,fetched_at,created_at,text,excerpt,link,unusual_score,parked_reason,attempts',
  order: 'created_at.desc,signal_id.desc',
  sortColumn: 'created_at',
  idColumn: 'signal_id',
  responseKey: 'signals',
}

const DECISIONS: ListSpec = {
  route: 'GET /internal/atlas/analyst',
  table: 'decisions',
  select: 'id,signal_id,decision,action,reason,summary,targets,confidence,model_name,analyst_version,outcome,entity_outcome,created_at',
  order: 'created_at.desc,id.desc',
  sortColumn: 'created_at',
  idColumn: 'id',
  responseKey: 'decisions',
}

const ENTITIES: ListSpec = {
  route: 'GET /internal/atlas/entities',
  table: 'entities',
  select: 'id,slug,name,type,aliases,summary,status,show_in_carousel,created_at,updated_at,entity_reviewed_at',
  order: 'updated_at.desc,id.desc',
  sortColumn: 'updated_at',
  idColumn: 'id',
  responseKey: 'entities',
}

const ENTITY_ITEMS: ListSpec = {
  route: 'GET /internal/atlas/entity-items',
  table: 'entity_items',
  select: 'id,title,note,angle,signal_id,occurred_at,created_at,status,main_entity_id,entity:entities!entity_items_main_entity_id_fkey(slug,name)',
  order: 'created_at.desc,id.desc',
  sortColumn: 'created_at',
  idColumn: 'id',
  responseKey: 'items',
  mapRow: flattenEntityItem,
}

const REQUEST_TIMEOUT_MS = 10_000
const MIN_INTERNAL_TOKEN_LENGTH = 32
const DEFAULT_LIST_LIMIT = 50
const MAX_LIST_LIMIT = 200
const MIN_Q_LENGTH = 2
const MAX_Q_LENGTH = 100
const Q_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

const ENTITY_TYPES: readonly string[] = ['organization', 'asset', 'protocol', 'person', 'topic', 'place', 'event', 'product', 'regulation']
const DECISION_VALUES: readonly string[] = ['keep', 'ignore', 'unclear']
const ANGLE_VALUES: readonly string[] = ['new_story', 'existing_story', 'plain_update']

const SHORTCUT_DURATION_RE = /^(\d{1,4})(m|h|d|w)$/
const ISO_PREFIX_RE = /^\d{4}-\d{2}-\d{2}/
const ENTITY_SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/
const SAFE_VALUE_RE = /^[A-Za-z0-9:_.-]{1,200}$/
const SAFE_WORD_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
// PostgREST reserved characters; rejected at the boundary rather than escaped.
const FILTER_VALUE_RE = /^[^,(){}*"\\%]{1,200}$/

const WINDOW_UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 } as const

export function createInternalAtlasBrowseRoutes(config: InternalAtlasBrowseRoutesConfig): Hono {
  const app = new Hono()
  const fetchImpl = config.fetchImpl ?? globalThis.fetch
  const restBaseUrl = `${config.supabaseUrl.replace(/\/$/, '')}/rest/v1`
  const now = config.now ?? (() => new Date())

  async function readRows(table: string, params: URLSearchParams): Promise<Row[]> {
    const url = new URL(`${restBaseUrl}/${table}`)
    params.forEach((value, key) => url.searchParams.append(key, value))
    const response = await fetchImpl(url, {
      headers: {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
        'Accept-Profile': 'atlas',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`Supabase read failed for ${table}: ${response.status}`)
    const body: unknown = await response.json()
    if (!Array.isArray(body)) throw new Error(`Supabase returned an invalid ${table} response`)
    return body as Row[]
  }

  async function listPage(spec: ListSpec, query: ParsedListQuery): Promise<{ rows: Row[]; nextCursor: string | null }> {
    const params = new URLSearchParams()
    params.set('select', spec.select)
    params.set('order', spec.order)
    // One extra row decides whether a next page exists.
    params.set('limit', String(query.limit + 1))
    query.filters.forEach((value, key) => params.append(key, value))
    if (query.cursor) {
      params.append('or', `(${spec.sortColumn}.lt.${query.cursor.t},and(${spec.sortColumn}.eq.${query.cursor.t},${spec.idColumn}.lt.${query.cursor.id}))`)
    }
    const rows = await readRows(spec.table, params)
    const page = rows.slice(0, query.limit)
    return {
      rows: page.map((row) => (spec.mapRow ? spec.mapRow(row) : row)),
      nextCursor: rows.length > query.limit ? cursorFor(page[page.length - 1], spec) : null,
    }
  }

  async function lookupEntityId(slug: string): Promise<string | undefined> {
    const params = new URLSearchParams()
    params.set('select', 'id')
    params.set('slug', `eq.${slug}`)
    params.set('limit', '1')
    const rows = await readRows('entities', params)
    const id = rows[0]?.id
    return typeof id === 'string' && id ? id : undefined
  }

  async function respondList(c: Context, spec: ListSpec, query: ParsedListQuery): Promise<Response> {
    const { rows, nextCursor } = await listPage(spec, query)
    return c.json({ [spec.responseKey]: rows, nextCursor, limit: query.limit })
  }

  function upstreamError(c: Context, err: unknown, route: string): Response {
    console.error(`[internal/atlas] ${route} failed`, err instanceof Error ? err.message : 'unknown error')
    return c.json({ error: 'Upstream read failed' }, 502)
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

  app.get('/signals', async (c) => {
    try {
      const parsed = parseSignalsQuery(c.req.query(), now().getTime())
      if (!parsed.ok) return c.json({ error: parsed.error }, 400)
      return await respondList(c, SIGNALS, parsed.query)
    } catch (err) {
      return upstreamError(c, err, SIGNALS.route)
    }
  })

  app.get('/analyst', async (c) => {
    try {
      const parsed = parseDecisionsQuery(c.req.query(), now().getTime())
      if (!parsed.ok) return c.json({ error: parsed.error }, 400)
      return await respondList(c, DECISIONS, parsed.query)
    } catch (err) {
      return upstreamError(c, err, DECISIONS.route)
    }
  })

  app.get('/entities', async (c) => {
    try {
      const parsed = parseEntitiesQuery(c.req.query(), now().getTime())
      if (!parsed.ok) return c.json({ error: parsed.error }, 400)
      return await respondList(c, ENTITIES, parsed.query)
    } catch (err) {
      return upstreamError(c, err, ENTITIES.route)
    }
  })

  app.get('/entity-items', async (c) => {
    try {
      const parsed = parseEntityItemsQuery(c.req.query(), now().getTime())
      if (!parsed.ok) return c.json({ error: parsed.error }, 400)
      if (parsed.query.entitySlug) {
        const entityId = await lookupEntityId(parsed.query.entitySlug)
        if (!entityId) return c.json({ items: [], nextCursor: null, limit: parsed.query.limit })
        parsed.query.filters.append('main_entity_id', `eq.${entityId}`)
      }
      return await respondList(c, ENTITY_ITEMS, parsed.query)
    } catch (err) {
      return upstreamError(c, err, ENTITY_ITEMS.route)
    }
  })

  return app
}

function parseSignalsQuery(query: Record<string, string>, nowMs: number): ParseResult {
  const filters = new URLSearchParams()
  const range = parseSinceUntil(query, nowMs)
  if ('error' in range) return { ok: false, error: range.error }
  if (range.since) filters.append('created_at', `gte.${range.since.iso}`)
  if (range.until) filters.append('created_at', `lte.${range.until.iso}`)

  const source = (query.source ?? '').trim()
  if (source) {
    if (!FILTER_VALUE_RE.test(source)) return { ok: false, error: 'Invalid source' }
    filters.append('source', `eq.${source}`)
  }

  const search = parseQ(query.q)
  if ('error' in search) return { ok: false, error: search.error }
  if (search.value) {
    // The text search is only index-friendly over a short window (#551):
    // default to the last 7 days and refuse anything wider.
    const sinceMs = range.since ? range.since.ms : nowMs - Q_WINDOW_MS
    const untilMs = range.until ? range.until.ms : nowMs
    if (untilMs - sinceMs > Q_WINDOW_MS) return { ok: false, error: 'q search needs a window of 7d or less' }
    if (!range.since) filters.append('created_at', `gte.${new Date(nowMs - Q_WINDOW_MS).toISOString()}`)
    filters.append('text', `ilike.*${search.value}*`)
  }

  return finishListQuery(filters, query)
}

function parseDecisionsQuery(query: Record<string, string>, nowMs: number): ParseResult {
  const filters = new URLSearchParams()
  const range = parseSinceUntil(query, nowMs)
  if ('error' in range) return { ok: false, error: range.error }
  if (range.since) filters.append('created_at', `gte.${range.since.iso}`)
  if (range.until) filters.append('created_at', `lte.${range.until.iso}`)

  const decision = (query.decision ?? '').trim()
  if (decision && !DECISION_VALUES.includes(decision)) return { ok: false, error: 'Invalid decision' }
  if (decision) filters.append('decision', `eq.${decision}`)

  const entity = (query.entity ?? '').trim()
  if (entity) {
    if (!ENTITY_SLUG_RE.test(entity)) return { ok: false, error: 'Invalid entity' }
    filters.append('targets', `cs.[{"entity":"${entity}"}]`)
  }

  const signalId = (query.signal_id ?? '').trim()
  if (signalId) {
    if (!SAFE_VALUE_RE.test(signalId)) return { ok: false, error: 'Invalid signal_id' }
    filters.append('signal_id', `eq.${signalId}`)
  }

  return finishListQuery(filters, query)
}

function parseEntitiesQuery(query: Record<string, string>, nowMs: number): ParseResult {
  const filters = new URLSearchParams()

  const type = (query.type ?? '').trim()
  if (type && !ENTITY_TYPES.includes(type)) return { ok: false, error: 'Invalid type' }
  if (type) filters.append('type', `eq.${type}`)

  const status = (query.status ?? '').trim()
  if (status) {
    if (!SAFE_WORD_RE.test(status)) return { ok: false, error: 'Invalid status' }
    filters.append('status', `eq.${status}`)
  }

  const carousel = (query.carousel ?? '').trim()
  if (carousel && carousel !== 'true' && carousel !== 'false') return { ok: false, error: 'Invalid carousel' }
  if (carousel) filters.append('show_in_carousel', `eq.${carousel}`)

  const search = parseQ(query.q)
  if ('error' in search) return { ok: false, error: search.error }
  if (search.value) {
    // Small table (~2k rows), so the search runs with no time bound.
    filters.append('or', `(name.ilike.*${search.value}*,slug.ilike.*${search.value}*,aliases.cs.{${search.value}})`)
  }

  if (query.since && query.since.trim()) {
    const since = parseTimeValue(query.since, nowMs)
    if (!since) return { ok: false, error: 'Invalid since' }
    filters.append('updated_at', `gte.${since.iso}`)
  }

  return finishListQuery(filters, query)
}

function parseEntityItemsQuery(query: Record<string, string>, nowMs: number): ParseResult {
  const filters = new URLSearchParams()
  const range = parseSinceUntil(query, nowMs)
  if ('error' in range) return { ok: false, error: range.error }
  if (range.since) filters.append('created_at', `gte.${range.since.iso}`)
  if (range.until) filters.append('created_at', `lte.${range.until.iso}`)

  let entitySlug: string | undefined
  const entity = (query.entity ?? '').trim()
  if (entity) {
    if (!ENTITY_SLUG_RE.test(entity)) return { ok: false, error: 'Invalid entity' }
    entitySlug = entity
  }

  const signalId = (query.signal_id ?? '').trim()
  if (signalId) {
    if (!SAFE_VALUE_RE.test(signalId)) return { ok: false, error: 'Invalid signal_id' }
    filters.append('signal_id', `eq.${signalId}`)
  }

  const angle = (query.angle ?? '').trim()
  if (angle && !ANGLE_VALUES.includes(angle)) return { ok: false, error: 'Invalid angle' }
  if (angle) filters.append('angle', `eq.${angle}`)

  const parsed: ParseResult = finishListQuery(filters, query)
  if (parsed.ok && entitySlug) parsed.query.entitySlug = entitySlug
  return parsed
}

function parseSinceUntil(query: Record<string, string>, nowMs: number): { since?: ParsedTime; until?: ParsedTime } | { error: string } {
  let since: ParsedTime | undefined
  let until: ParsedTime | undefined
  if (query.since && query.since.trim()) {
    since = parseTimeValue(query.since, nowMs)
    if (!since) return { error: 'Invalid since' }
  }
  if (query.until && query.until.trim()) {
    until = parseTimeValue(query.until, nowMs)
    if (!until) return { error: 'Invalid until' }
  }
  if (since && until && since.ms > until.ms) return { error: 'since must be before until' }
  return { since, until }
}

/** Shortcut durations (24h, 3d, 2w) resolve relative to now; dates stay ISO-prefixed. */
function parseTimeValue(input: string, nowMs: number): ParsedTime | undefined {
  const value = input.trim()
  const shortcut = SHORTCUT_DURATION_RE.exec(value)
  if (shortcut) {
    const ms = nowMs - Number.parseInt(shortcut[1], 10) * WINDOW_UNIT_MS[shortcut[2] as keyof typeof WINDOW_UNIT_MS]
    return { iso: new Date(ms).toISOString(), ms }
  }
  if (!ISO_PREFIX_RE.test(value)) return undefined
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return undefined
  return { iso: new Date(ms).toISOString(), ms }
}

function parseQ(input: string | undefined): { value: string } | { error: string } {
  const value = (input ?? '').trim()
  if (!value) return { value: '' }
  if (!FILTER_VALUE_RE.test(value) || value.length < MIN_Q_LENGTH || value.length > MAX_Q_LENGTH) {
    return { error: 'Invalid q' }
  }
  return { value }
}

function parseLimit(input: string | undefined): number {
  const parsed = Number.parseInt(input ?? '', 10)
  if (!Number.isFinite(parsed)) return DEFAULT_LIST_LIMIT
  return Math.min(MAX_LIST_LIMIT, Math.max(1, parsed))
}

/** Absent cursor → undefined; unparseable or unsafe cursor → null (invalid). */
function decodeCursor(input: string | undefined): CursorKey | null | undefined {
  if (!input || !input.trim()) return undefined
  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(input, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return null
  const { t, id } = decoded as { t?: unknown; id?: unknown }
  if (typeof t !== 'string' || !isCursorTimestamp(t)) return null
  if (typeof id !== 'string' || !SAFE_VALUE_RE.test(id)) return null
  return { t, id }
}

function finishListQuery(filters: URLSearchParams, query: Record<string, string>): ParseResult {
  const cursor = decodeCursor(query.cursor)
  if (cursor === null) return { ok: false, error: 'Invalid cursor' }
  return { ok: true, query: { filters, limit: parseLimit(query.limit), ...(cursor ? { cursor } : {}) } }
}

function cursorFor(row: Row | undefined, spec: ListSpec): string | null {
  if (!row) return null
  const t = row[spec.sortColumn]
  const id = row[spec.idColumn]
  if (typeof t !== 'string' || !isCursorTimestamp(t)) return null
  if (typeof id !== 'string' || !SAFE_VALUE_RE.test(id)) return null
  return Buffer.from(JSON.stringify({ t, id }), 'utf8').toString('base64url')
}

function isCursorTimestamp(value: string): boolean {
  return ISO_PREFIX_RE.test(value) && Number.isFinite(Date.parse(value))
}

/** Replaces the nested `{slug, name}` embed with flat entity_slug / entity_name fields. */
function flattenEntityItem(row: Row): Row {
  const { entity, ...rest } = row
  const embedded = entity && typeof entity === 'object' && !Array.isArray(entity) ? entity as Row : {}
  return {
    ...rest,
    entity_slug: typeof embedded.slug === 'string' ? embedded.slug : null,
    entity_name: typeof embedded.name === 'string' ? embedded.name : null,
  }
}

function hasSecureToken(token: string | undefined): token is string {
  return Boolean(token && Buffer.byteLength(token, 'utf8') >= MIN_INTERNAL_TOKEN_LENGTH)
}

function tokensMatch(token: string, expected: string): boolean {
  const left = Buffer.from(token)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}