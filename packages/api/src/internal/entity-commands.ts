import { timingSafeEqual } from 'node:crypto'
import { createSupabaseClient } from '@myboon/shared/supabase-client'
import entityManager from '@myboon/collectors/entity-manager'
import type {
  ManualEntityApplyResult,
  ManualEntityPreview,
} from '@myboon/collectors/entity-manager'
import { Hono } from 'hono'
import type { Context } from 'hono'

const {
  EntityService,
  ManualEntityConflictError,
  ManualEntityValidationError,
  SupabaseEntityMemoryStore,
} = entityManager

const MIN_INTERNAL_TOKEN_LENGTH = 32
const MAX_BODY_BYTES = 256 * 1024

export interface EntityCommandService {
  previewManual(input: unknown): Promise<ManualEntityPreview>
  applyManual(input: unknown, previewHash: string): Promise<ManualEntityApplyResult>
}

interface InternalEntityCommandRoutesConfig {
  internalWriteToken?: string
  supabaseUrl?: string
  serviceRoleKey?: string
  service?: EntityCommandService
}

export function createInternalEntityCommandRoutes(config: InternalEntityCommandRoutesConfig): Hono {
  const app = new Hono()
  const service = config.service ?? createService(config)

  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'private, no-store, max-age=0')
    c.header('Pragma', 'no-cache')
    c.header('X-Robots-Tag', 'noindex, nofollow, noarchive')
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('Referrer-Policy', 'no-referrer')
    c.header('Vary', 'Authorization')

    if (!hasSecureToken(config.internalWriteToken)) {
      return c.json({ error: 'Internal Entity write service is not configured' }, 503)
    }
    const authorization = c.req.header('authorization') ?? ''
    const token = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : ''
    if (!tokensMatch(token, config.internalWriteToken)) return c.json({ error: 'Unauthorized' }, 401)
    await next()
  })

  app.post('/preview', async (c) => {
    try {
      const body = await readBody(c)
      const preview = await service.previewManual(body.command)
      return c.json(preview)
    } catch (error) {
      return commandError(c, error, 'POST /internal/entity-commands/preview')
    }
  })

  app.post('/apply', async (c) => {
    try {
      const body = await readBody(c)
      const previewHash = typeof body.previewHash === 'string' ? body.previewHash : ''
      if (!previewHash) throw new ManualEntityValidationError('previewHash is required.')
      const result = await service.applyManual(body.command, previewHash)
      return c.json(result)
    } catch (error) {
      return commandError(c, error, 'POST /internal/entity-commands/apply')
    }
  })

  return app
}

function createService(config: InternalEntityCommandRoutesConfig): EntityCommandService {
  if (!config.supabaseUrl || !config.serviceRoleKey) {
    return {
      async previewManual() { throw new Error('Entity command database is not configured') },
      async applyManual() { throw new Error('Entity command database is not configured') },
    }
  }
  const db = createSupabaseClient(config.supabaseUrl, config.serviceRoleKey, {
    clientOptions: { auth: { persistSession: false, autoRefreshToken: false } },
  })
  return new EntityService(new SupabaseEntityMemoryStore(db))
}

async function readBody(c: Context): Promise<Record<string, unknown>> {
  const contentLength = Number(c.req.header('content-length') ?? 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw new ManualEntityValidationError('Request payload is too large.')
  }
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ManualEntityValidationError('Request body must be a JSON object.')
  }
  return body as Record<string, unknown>
}

function commandError(c: Context, error: unknown, label: string) {
  if (error instanceof ManualEntityValidationError) return c.json({ error: error.message, code: error.code }, 400)
  if (error instanceof ManualEntityConflictError) return c.json({ error: error.message, code: error.code }, 409)
  console.error(`[internal/entity-commands] ${label} failed`, error instanceof Error ? error.message : 'unknown error')
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
