import { Hono } from 'hono'

export interface NarrativeRoutesConfig {
  supabaseUrl: string
  serviceRoleKey: string
  fetch?: typeof globalThis.fetch
}

export interface FeedItemDto {
  updateKey: string
  title: string
  summary: string
  publishedAt: string
  imageUrl: string | null
  imageKind: NarrativeImageKind | null
  imageAttribution: string | null
}

export interface FeedDetailDto extends FeedItemDto {
  content: string
}

interface NarrativeRow {
  id: string
  title: string
  content_small: string
  content_full?: string
  published_at: string
  source_memory_ids: string[]
}

type NarrativeImageKind = 'content' | 'source_avatar'

interface NarrativeImage {
  imageUrl: string
  imageKind: NarrativeImageKind
  imageAttribution: string | null
}

const LIST_SELECT = 'id,title,content_small,published_at,source_memory_ids'
const DETAIL_SELECT = 'id,title,content_small,content_full,published_at,source_memory_ids'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50
const MAX_OFFSET = 10_000
const REQUEST_TIMEOUT_MS = 10_000

export function createNarrativeRoutes(config: NarrativeRoutesConfig): Hono {
  const app = new Hono()
  const restBaseUrl = `${config.supabaseUrl.replace(/\/$/, '')}/rest/v1`
  const fetchImpl = config.fetch ?? globalThis.fetch

  function supabaseHeaders(): Record<string, string> {
    return {
      apikey: config.serviceRoleKey,
      Authorization: `Bearer ${config.serviceRoleKey}`,
      'Content-Type': 'application/json',
    }
  }

  async function readNarratives(params: URLSearchParams): Promise<Response> {
    const url = new URL(`${restBaseUrl}/published_narratives`)
    params.forEach((value, key) => url.searchParams.append(key, value))
    return fetchImpl(url, {
      headers: supabaseHeaders(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  }

  app.get('/', async (c) => {
    const limit = boundedInteger(c.req.query('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT)
    const offset = boundedInteger(c.req.query('offset'), 0, 0, MAX_OFFSET)
    const params = publicNarrativeFilters(LIST_SELECT)
    params.set('order', 'published_at.desc,id.desc')
    params.set('limit', String(limit))
    params.set('offset', String(offset))

    try {
      const response = await readNarratives(params)
      if (!response.ok) {
        await logUpstreamFailure('GET /narratives', response)
        return c.json({ error: 'Internal server error' }, 500)
      }

      const rows = await response.json() as unknown
      if (!Array.isArray(rows)) throw new Error('Supabase returned a non-array response')
      const narratives = rows.flatMap((row) => {
        const narrative = narrativeRow(row, false)
        return narrative ? [narrative] : []
      })
      const imagesByMemoryId = await readMemoryImages(narratives)
      return c.json(narratives.map((row) => toFeedItem(row, imagesByMemoryId)))
    } catch (error) {
      console.error('[api] Unexpected error in GET /narratives:', error)
      return c.json({ error: 'Internal server error' }, 500)
    }
  })

  app.get('/:updateKey', async (c) => {
    const updateKey = c.req.param('updateKey')
    if (!UUID_RE.test(updateKey)) {
      return c.json({ error: 'Bad request' }, 400)
    }

    const params = publicNarrativeFilters(DETAIL_SELECT)
    params.set('id', `eq.${updateKey}`)
    params.set('limit', '1')

    try {
      const response = await readNarratives(params)
      if (!response.ok) {
        await logUpstreamFailure('GET /narratives/:updateKey', response)
        return c.json({ error: 'Internal server error' }, 500)
      }

      const rows = await response.json() as unknown
      if (!Array.isArray(rows)) throw new Error('Supabase returned a non-array response')
      if (rows.length === 0) return c.json({ error: 'Not found' }, 404)

      const narrative = narrativeRow(rows[0], true)
      if (!narrative) return c.json({ error: 'Not found' }, 404)
      const imagesByMemoryId = await readMemoryImages([narrative])
      const detail = toFeedDetail(narrative, imagesByMemoryId)
      return detail
        ? c.json(detail)
        : c.json({ error: 'Not found' }, 404)
    } catch (error) {
      console.error(`[api] Unexpected error in GET /narratives/${updateKey}:`, error)
      return c.json({ error: 'Internal server error' }, 500)
    }
  })

  async function readMemoryImages(rows: NarrativeRow[]): Promise<Map<string, NarrativeImage>> {
    const memoryIds = [...new Set(rows.flatMap((row) => row.source_memory_ids))]
      .filter((id) => UUID_RE.test(id))
    const images = new Map<string, NarrativeImage>()
    if (memoryIds.length === 0) return images

    const params = new URLSearchParams({
      select: 'id,context',
      id: `in.(${memoryIds.join(',')})`,
    })
    try {
      const url = new URL(`${restBaseUrl}/entity_memories`)
      params.forEach((value, key) => url.searchParams.append(key, value))
      const response = await fetchImpl(url, {
        headers: supabaseHeaders(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!response.ok) return images
      const body: unknown = await response.json()
      if (!Array.isArray(body)) return images
      for (const value of body) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue
        const record = value as Record<string, unknown>
        if (typeof record.id !== 'string' || !memoryIds.includes(record.id)) continue
        const image = narrativeImage(record.context)
        if (image) images.set(record.id, image)
      }
    } catch {
      // Media enrichment is optional; a transient context read must not take
      // down the public feed after the narrative query already succeeded.
    }
    return images
  }

  return app
}

function publicNarrativeFilters(select: string): URLSearchParams {
  const params = new URLSearchParams()
  params.set('select', select)
  params.set('status', 'eq.published')
  params.set('entity_id', 'not.is.null')
  params.set('title', 'not.is.null')
  params.set('content_small', 'not.is.null')
  params.set('content_full', 'not.is.null')
  params.set('published_at', 'not.is.null')
  return params
}

function boundedInteger(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || !/^\d+$/.test(raw)) return fallback
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed)) return fallback
  return Math.min(Math.max(parsed, min), max)
}

function toFeedItem(row: NarrativeRow, imagesByMemoryId: Map<string, NarrativeImage>): FeedItemDto {
  const image = preferredNarrativeImage(row, imagesByMemoryId)
  return {
    updateKey: row.id,
    title: row.title,
    summary: row.content_small,
    publishedAt: row.published_at,
    imageUrl: image?.imageUrl ?? null,
    imageKind: image?.imageKind ?? null,
    imageAttribution: image?.imageAttribution ?? null,
  }
}

function toFeedDetail(row: NarrativeRow, imagesByMemoryId: Map<string, NarrativeImage>): FeedDetailDto {
  const image = preferredNarrativeImage(row, imagesByMemoryId)
  return {
    updateKey: row.id,
    title: row.title,
    summary: row.content_small,
    content: row.content_full!,
    publishedAt: row.published_at,
    imageUrl: image?.imageUrl ?? null,
    imageKind: image?.imageKind ?? null,
    imageAttribution: image?.imageAttribution ?? null,
  }
}

function preferredNarrativeImage(
  row: NarrativeRow,
  imagesByMemoryId: Map<string, NarrativeImage>,
): NarrativeImage | null {
  const available = row.source_memory_ids.flatMap((id) => {
    const image = imagesByMemoryId.get(id)
    return image ? [image] : []
  })
  return available.find((image) => image.imageKind === 'content') ?? available[0] ?? null
}

function narrativeImage(value: unknown): NarrativeImage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const context = value as Record<string, unknown>
  const imageUrl = safeHttpUrl(context.image_url)
  if (!imageUrl) return null
  const imageKind = context.image_kind === 'source_avatar' ? 'source_avatar' : 'content'
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

function narrativeRow(value: unknown, requireFullContent: boolean): NarrativeRow | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const row = value as Record<string, unknown>
  const requiredFields = ['id', 'title', 'content_small', 'published_at'] as const
  for (const field of requiredFields) {
    if (typeof row[field] !== 'string' || row[field].trim().length === 0) {
      return null
    }
  }
  if (!UUID_RE.test(row.id as string) || !Number.isFinite(Date.parse(row.published_at as string))) return null
  if (requireFullContent && (typeof row.content_full !== 'string' || row.content_full.trim().length === 0)) {
    return null
  }

  return {
    id: (row.id as string).trim(),
    title: (row.title as string).trim(),
    content_small: (row.content_small as string).trim(),
    content_full: typeof row.content_full === 'string' ? row.content_full.trim() : undefined,
    published_at: (row.published_at as string).trim(),
    source_memory_ids: Array.isArray(row.source_memory_ids)
      ? row.source_memory_ids.filter((id): id is string => typeof id === 'string')
      : [],
  }
}

async function logUpstreamFailure(context: string, response: Response): Promise<void> {
  const detail = (await response.text()).slice(0, 500)
  console.error(`[api] Supabase error in ${context}: ${response.status}: ${detail}`)
}
