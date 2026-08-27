import type {
  EntityKnowledgeMemoryType,
  EntityKnowledgeMemoryV1,
  EntityKnowledgeReader,
  PriorityClass,
} from '@myboon/collectors/entity-manager'
import entityManager from '@myboon/collectors/entity-manager'
import { timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import type { Context } from 'hono'

const DEFAULT_LIMIT = 20
const {
  ENTITY_KNOWLEDGE_MAX_PAGE_SIZE,
  ENTITY_MEMORY_CHANGES_START_CURSOR,
  InvalidEntityKnowledgeCursorError,
} = entityManager
const ENTITY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MEMORY_TYPES = new Set<EntityKnowledgeMemoryType>([
  'research_note', 'market_signal', 'news_event', 'social_signal', 'timeline_event', 'metric_change',
])
const PRIORITIES = new Set<PriorityClass>(['P0', 'P1', 'P2', 'P3'])

export interface EntityKnowledgeRoutesConfig {
  reader: EntityKnowledgeReader
  internalToken?: string
}

/**
 * Versioned, source-neutral read surface for client feeds and downstream teams.
 * The consumer DTO is deliberately allowlisted; raw context/evidence and service
 * credentials never cross this API boundary.
 */
export function createEntityKnowledgeRoutes(config: EntityKnowledgeRoutesConfig): Hono {
  const app = new Hono()

  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'private, no-store, max-age=0')
    c.header('X-Robots-Tag', 'noindex, nofollow, noarchive')
    c.header('Vary', 'Authorization')
    if (!config.internalToken || Buffer.byteLength(config.internalToken, 'utf8') < 32) {
      return c.json({ error: 'Internal dashboard token is not configured' }, 503)
    }
    const authorization = c.req.header('authorization') ?? ''
    const token = authorization.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length).trim() : ''
    if (!tokensMatch(token, config.internalToken)) return c.json({ error: 'Unauthorized' }, 401)
    await next()
  })

  app.get('/recent', async (c) => {
    try {
      const since = optionalTimestamp(c.req.query('since'))
      const priorityClasses = enumList(c.req.queries('priority'), PRIORITIES, 'priority')
      const page = await config.reader.getRecentEntityMemories({
        limit: limit(c.req.query('limit')),
        ...(since ? { since } : {}),
        ...(c.req.query('cursor') ? { cursor: c.req.query('cursor') } : {}),
        ...(priorityClasses ? { priorityClasses } : {}),
      })
      return c.json(publicPage(page))
    } catch (error) {
      return requestError(c, error)
    }
  })

  app.get('/entities/:entityId/memories', async (c) => {
    const entityId = c.req.param('entityId')
    if (!ENTITY_ID_RE.test(entityId)) return c.json({ error: 'Invalid entity ID' }, 400)
    try {
      const since = optionalTimestamp(c.req.query('since'))
      const memoryTypes = enumList(c.req.queries('memoryType'), MEMORY_TYPES, 'memoryType')
      const page = await config.reader.getEntityMemories({
        entityId,
        limit: limit(c.req.query('limit')),
        ...(since ? { since } : {}),
        ...(c.req.query('cursor') ? { cursor: c.req.query('cursor') } : {}),
        ...(memoryTypes ? { memoryTypes } : {}),
      })
      return c.json(publicPage(page))
    } catch (error) {
      return requestError(c, error)
    }
  })

  app.get('/changes', async (c) => {
    try {
      const page = await config.reader.getEntityMemoryChanges({
        afterCursor: c.req.query('after') || ENTITY_MEMORY_CHANGES_START_CURSOR,
        limit: limit(c.req.query('limit')),
      })
      return c.json({
        schemaVersion: page.schemaVersion,
        changes: page.changes.map((change) => ({
          changeType: change.changeType,
          changedAt: change.changedAt,
          cursor: change.cursor,
          memory: publicMemory(change.memory),
        })),
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      })
    } catch (error) {
      return requestError(c, error)
    }
  })

  return app
}

function publicPage(page: Awaited<ReturnType<EntityKnowledgeReader['getRecentEntityMemories']>>) {
  return {
    schemaVersion: page.schemaVersion,
    items: page.items.map(publicMemory),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  }
}

function publicMemory(memory: EntityKnowledgeMemoryV1) {
  return {
    schemaVersion: memory.schemaVersion,
    id: memory.id,
    entityId: memory.entityId,
    memoryType: memory.memoryType,
    title: memory.title,
    summary: memory.summary,
    body: memory.body,
    eventAt: memory.eventAt,
    observedAt: memory.observedAt,
    confidence: memory.confidence,
    mentions: memory.mentions,
    metrics: memory.metrics,
    media: memory.media,
    priorityClass: memory.priorityClass,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
  }
}

function limit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT
  if (!/^\d+$/.test(raw)) throw new TypeError('limit must be a positive integer')
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1 || value > ENTITY_KNOWLEDGE_MAX_PAGE_SIZE) {
    throw new RangeError(`limit must be between 1 and ${ENTITY_KNOWLEDGE_MAX_PAGE_SIZE}`)
  }
  return value
}

function optionalTimestamp(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  if (!Number.isFinite(Date.parse(raw))) throw new TypeError('since must be a valid timestamp')
  return new Date(raw).toISOString()
}

function enumList<T extends string>(raw: string[] | undefined, allowed: ReadonlySet<T>, name: string): T[] | undefined {
  if (!raw || raw.length === 0) return undefined
  const values = raw.flatMap((value) => value.split(',')).filter(Boolean)
  if (values.some((value) => !allowed.has(value as T))) throw new TypeError(`Unsupported ${name}`)
  return [...new Set(values as T[])]
}

function requestError(c: Context, error: unknown) {
  if (error instanceof InvalidEntityKnowledgeCursorError
    || error instanceof TypeError
    || error instanceof RangeError) {
    return c.json({ error: error.message }, 400)
  }
  console.error('[api] Entity Knowledge read failed:', error)
  return c.json({ error: 'Internal server error' }, 500)
}

function tokensMatch(leftValue: string, rightValue: string): boolean {
  const left = Buffer.from(leftValue, 'utf8')
  const right = Buffer.from(rightValue, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}
