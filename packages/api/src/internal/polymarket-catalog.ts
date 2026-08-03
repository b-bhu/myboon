import { timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type {
  PolymarketCatalogItemInput,
  PolymarketCatalogStore,
} from '../polymarket/catalog/contracts.js'
import {
  PolymarketCatalogConflictError,
  PolymarketCatalogValidationError,
} from '../polymarket/catalog/contracts.js'
import { resolvePolymarketCatalogItems, TAG_RULE_MAX_LIMIT } from '../polymarket/catalog/source.js'
import { listSportsRuleOptions, SPORTS_TAG_OPTIONS } from '../polymarket/catalog/sports-rules.js'
import type { SportsRuleOption } from '../polymarket/catalog/sports-rules.js'

interface InternalPolymarketCatalogRoutesConfig {
  internalReadToken?: string
  internalWriteToken?: string
  store: PolymarketCatalogStore
  resolveItems?: (items: PolymarketCatalogItemInput[]) => Promise<PolymarketCatalogItemInput[]>
  listSportsOptions?: () => Promise<SportsRuleOption[]>
}

const MIN_INTERNAL_TOKEN_LENGTH = 32
const MAX_BODY_BYTES = 128 * 1024
const MAX_ITEMS = 100
const SAFE_COLLECTION_KEY_RE = /^[a-z][a-z0-9_-]{0,63}$/
const SAFE_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/

export function createInternalPolymarketCatalogRoutes(
  config: InternalPolymarketCatalogRoutesConfig,
): Hono {
  const routes = new Hono()
  const resolveItems = config.resolveItems ?? resolvePolymarketCatalogItems
  const listSportsOptions = config.listSportsOptions ?? listSportsRuleOptions

  routes.use('*', async (c, next) => {
    c.header('Cache-Control', 'private, no-store, max-age=0')
    c.header('Pragma', 'no-cache')
    c.header('X-Robots-Tag', 'noindex, nofollow, noarchive')
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('Referrer-Policy', 'no-referrer')
    c.header('Vary', 'Authorization')

    const isRead = c.req.method === 'GET'
    const expected = isRead ? config.internalReadToken : config.internalWriteToken
    if (!hasSecureToken(expected)) {
      return c.json({ error: `Internal Polymarket catalog ${isRead ? 'read' : 'write'} service is not configured` }, 503)
    }
    const authorization = c.req.header('authorization') ?? ''
    const token = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : ''
    if (!tokensMatch(token, expected)) return c.json({ error: 'Unauthorized' }, 401)
    await next()
  })

  routes.get('/options/sports', async (c) => {
    try {
      return c.json({
        options: await listSportsOptions(),
        defaults: { windowDays: 14, limit: 20, marketType: 'moneyline' },
      })
    } catch (error) {
      return catalogError(c, error, 'GET /internal/polymarket/collections/options/sports')
    }
  })

  routes.get('/options/tags', (c) => c.json({
    options: SPORTS_TAG_OPTIONS,
    defaults: { windowDays: 14, limit: 60, marketType: 'moneyline' },
    maxLimit: TAG_RULE_MAX_LIMIT,
  }))

  routes.get('/:key', async (c) => {
    const key = collectionKey(c)
    if (!key) return c.json({ error: 'Invalid collection key' }, 400)
    try {
      const state = await config.store.getCollection(key)
      if (!state) return c.json({ error: 'Collection not found' }, 404)
      return c.json(state)
    } catch (error) {
      return catalogError(c, error, `GET /internal/polymarket/collections/${key}`)
    }
  })

  routes.post('/:key/draft', async (c) => {
    const key = collectionKey(c)
    if (!key) return c.json({ error: 'Invalid collection key' }, 400)
    try {
      const body = await readBody(c)
      const expectedRevision = nullableRevision(body.expectedRevision)
      const items = parseItems(body.items)
      const resolvedItems = await resolveItems(items)
      const state = await config.store.saveDraft({
        key,
        expectedRevision,
        items: resolvedItems,
        actor: 'dashboard',
      })
      return c.json(state)
    } catch (error) {
      return catalogError(c, error, `POST /internal/polymarket/collections/${key}/draft`)
    }
  })

  routes.post('/:key/publish', async (c) => {
    const key = collectionKey(c)
    if (!key) return c.json({ error: 'Invalid collection key' }, 400)
    try {
      const body = await readBody(c)
      const expectedRevision = requiredRevision(body.expectedRevision)
      const state = await config.store.publish({ key, expectedRevision, actor: 'dashboard' })
      return c.json(state)
    } catch (error) {
      return catalogError(c, error, `POST /internal/polymarket/collections/${key}/publish`)
    }
  })

  return routes
}

async function readBody(c: Context): Promise<Record<string, unknown>> {
  const contentLength = Number(c.req.header('content-length') ?? 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw new PolymarketCatalogValidationError('Request payload is too large.')
  }
  const text = await c.req.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
    throw new PolymarketCatalogValidationError('Request payload is too large.')
  }
  const body = JSON.parse(text || 'null') as unknown
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new PolymarketCatalogValidationError('Request body must be a JSON object.')
  }
  return body as Record<string, unknown>
}

function parseItems(value: unknown): PolymarketCatalogItemInput[] {
  if (!Array.isArray(value)) throw new PolymarketCatalogValidationError('items must be an array.')
  if (value.length > MAX_ITEMS) throw new PolymarketCatalogValidationError(`items supports at most ${MAX_ITEMS} entries.`)

  const seen = new Set<string>()
  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new PolymarketCatalogValidationError(`items[${index}] must be an object.`)
    }
    const item = raw as Record<string, unknown>
    const sourceKind = item.sourceKind
    const isRuleKind = sourceKind === 'sports_rule' || sourceKind === 'sports_tag'
    const rawSourceSlug = typeof item.sourceSlug === 'string' ? item.sourceSlug.trim() : ''
    const sourceSlug = isRuleKind ? rawSourceSlug.toLowerCase() : rawSourceSlug
    if (sourceKind !== 'event' && sourceKind !== 'market' && !isRuleKind) {
      throw new PolymarketCatalogValidationError(
        `items[${index}].sourceKind must be event, market, sports_rule, or sports_tag.`,
      )
    }
    if (!SAFE_SLUG_RE.test(sourceSlug)) {
      throw new PolymarketCatalogValidationError(`items[${index}].sourceSlug is invalid.`)
    }
    const dedupeKey = `${sourceKind}:${sourceSlug}`
    if (seen.has(dedupeKey)) throw new PolymarketCatalogValidationError(`Duplicate catalog item: ${sourceSlug}`)
    seen.add(dedupeKey)

    const ruleConfig = isRuleKind
      ? parseSportsRuleConfig(item.ruleConfig, index, sourceKind)
      : null
    return {
      sourceKind,
      sourceSlug,
      category: isRuleKind ? 'sports' : optionalShortText(item.category, `items[${index}].category`),
      sport: isRuleKind ? null : optionalShortText(item.sport, `items[${index}].sport`),
      isEnabled: true,
      displayOverrides: {},
      ...(ruleConfig ? { ruleConfig } : {}),
    }
  })
}

function parseSportsRuleConfig(value: unknown, index: number, sourceKind: 'sports_rule' | 'sports_tag') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PolymarketCatalogValidationError(`items[${index}].ruleConfig is required for automatic sports sources.`)
  }
  const config = value as Record<string, unknown>
  const windowDays = config.windowDays
  const limit = config.limit
  const maxLimit = sourceKind === 'sports_tag' ? TAG_RULE_MAX_LIMIT : 50
  if (!Number.isSafeInteger(windowDays) || Number(windowDays) < 1 || Number(windowDays) > 30) {
    throw new PolymarketCatalogValidationError(`items[${index}].ruleConfig.windowDays must be between 1 and 30.`)
  }
  if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > maxLimit) {
    throw new PolymarketCatalogValidationError(`items[${index}].ruleConfig.limit must be between 1 and ${maxLimit}.`)
  }
  if (config.marketType !== 'moneyline') {
    throw new PolymarketCatalogValidationError(`items[${index}].ruleConfig.marketType must be moneyline.`)
  }
  return { windowDays: Number(windowDays), limit: Number(limit), marketType: 'moneyline' as const }
}

function optionalShortText(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw new PolymarketCatalogValidationError(`${label} must be a string.`)
  const normalized = value.trim()
  if (normalized.length > 64) throw new PolymarketCatalogValidationError(`${label} is too long.`)
  return normalized || null
}

function nullableRevision(value: unknown): number | null {
  if (value === null || value === undefined) return null
  return requiredRevision(value)
}

function requiredRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new PolymarketCatalogValidationError('expectedRevision must be a positive integer.')
  }
  return Number(value)
}

function collectionKey(c: Context): string | null {
  const key = c.req.param('key') ?? ''
  return SAFE_COLLECTION_KEY_RE.test(key) ? key : null
}

function catalogError(c: Context, error: unknown, label: string) {
  if (error instanceof PolymarketCatalogValidationError) {
    return c.json({ error: error.message, code: error.code }, 400)
  }
  if (error instanceof PolymarketCatalogConflictError) {
    return c.json({ error: error.message, code: error.code }, 409)
  }
  if (error instanceof SyntaxError) {
    return c.json({ error: 'Request body must be valid JSON.', code: 'catalog_validation_error' }, 400)
  }
  console.error(`[internal/polymarket-catalog] ${label} failed`, error instanceof Error ? error.message : 'unknown error')
  return c.json({ error: 'Internal server error' }, 500)
}

function hasSecureToken(token: string | undefined): token is string {
  return Boolean(token && Buffer.byteLength(token, 'utf8') >= MIN_INTERNAL_TOKEN_LENGTH)
}

function tokensMatch(token: string, expected: string): boolean {
  const left = Buffer.from(token)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}
