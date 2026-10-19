import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'

export const INTERNAL_SESSION_COOKIE = 'myboon_internal_dashboard_session'

const LEGACY_INTERNAL_ENTITY_SESSION_COOKIE = 'myboon_internal_entity_session'
const MIN_SECRET_BYTES = 32
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 4
const MAX_WRITE_BODY_BYTES = 256 * 1024
const INTERNAL_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'strict' as const,
  secure: process.env.NODE_ENV === 'production',
}
const INTERNAL_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  Pragma: 'no-cache',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
}

interface InternalReadProxyOptions {
  configurationMessage?: string
  notFoundMessage?: string
  unavailableMessage?: string
}

interface InternalWriteProxyOptions {
  writeToken?: string
  unavailableMessage?: string
  passthroughStatuses?: number[]
}

export async function getInternalSession(): Promise<string> {
  const cookieStore = await cookies()
  return cookieStore.get(INTERNAL_SESSION_COOKIE)?.value ?? ''
}

export function expectedInternalToken(): string {
  return process.env.INTERNAL_DASHBOARD_TOKEN ?? ''
}

export function expectedInternalPolymarketCatalogWriteToken(): string {
  return process.env.INTERNAL_POLYMARKET_CATALOG_WRITE_TOKEN ?? ''
}

export function isInternalDashboardAuthBypassed(): boolean {
  return process.env.NODE_ENV !== 'production'
    && process.env.INTERNAL_DASHBOARD_AUTH_BYPASS === '1'
}

export function isInternalDashboardConfigured(): boolean {
  return isStrongSecret(expectedInternalToken())
    && (isInternalDashboardAuthBypassed()
      || isStrongSecret(process.env.INTERNAL_DASHBOARD_SESSION_SECRET ?? ''))
}

export function hasValidDashboardToken(token: string): boolean {
  const expected = expectedInternalToken()
  return isInternalDashboardConfigured() && secureEqual(token, expected)
}

export function hasValidInternalSession(session: string): boolean {
  if (isInternalDashboardAuthBypassed()) return true

  const signingKey = sessionSigningKey()
  if (!signingKey) return false

  const [version, expiresAt, nonce, signature] = session.split('.')
  if (version !== 'v1' || !/^\d{10}$/.test(expiresAt) || !/^[A-Za-z0-9_-]{16,}$/.test(nonce)) return false
  if (!signature || Number(expiresAt) <= Math.floor(Date.now() / 1000)) return false

  const payload = `${version}.${expiresAt}.${nonce}`
  const expectedSignature = signSession(payload, signingKey)
  return secureEqual(signature, expectedSignature)
}

export async function setInternalSession(): Promise<void> {
  const cookieStore = await cookies()

  // Remove the original path-scoped cookie so requests to /internal/entities do
  // not send two cookies with the same legacy name after the dashboard expands.
  cookieStore.set(LEGACY_INTERNAL_ENTITY_SESSION_COOKIE, '', {
    ...INTERNAL_COOKIE_OPTIONS,
    path: '/internal/entities',
    maxAge: 0,
  })
  cookieStore.set(INTERNAL_SESSION_COOKIE, createInternalSession(), {
    ...INTERNAL_COOKIE_OPTIONS,
    path: '/internal',
    maxAge: SESSION_MAX_AGE_SECONDS,
  })
}

export async function clearInternalSession(): Promise<void> {
  const cookieStore = await cookies()
  cookieStore.set(INTERNAL_SESSION_COOKIE, '', {
    ...INTERNAL_COOKIE_OPTIONS,
    path: '/internal',
    maxAge: 0,
  })
  cookieStore.set(LEGACY_INTERNAL_ENTITY_SESSION_COOKIE, '', {
    ...INTERNAL_COOKIE_OPTIONS,
    path: '/internal/entities',
    maxAge: 0,
  })
}

export function internalApiBaseUrl(): string {
  return (process.env.INTERNAL_API_BASE_URL ?? process.env.MYBOON_API_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '')
}

export function internalJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: INTERNAL_HEADERS })
}

export function requestHasTrustedOrigin(request: Request): boolean {
  const origin = request.headers.get('origin')
  if (!origin) return false

  try {
    const originUrl = new URL(origin)
    const requestUrl = new URL(request.url)
    const forwardedHost = request.headers.get('x-forwarded-host')
    const host = forwardedHost ?? request.headers.get('host') ?? requestUrl.host
    const isLocalhost = originUrl.hostname === 'localhost'
      || originUrl.hostname === '127.0.0.1'
      || originUrl.hostname === '::1'
    const hasTrustedProtocol = originUrl.protocol === 'https:' || (isLocalhost && originUrl.protocol === 'http:')
    return hasTrustedProtocol && originUrl.host === host
  } catch {
    return false
  }
}

export function requestClientKey(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')
  const address = forwarded?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || 'unknown'
  return address.slice(0, 128)
}

export async function proxyInternalApi(
  path: string,
  options: InternalReadProxyOptions = {},
): Promise<NextResponse> {
  const session = await getInternalSession()
  const unavailableMessage = options.unavailableMessage ?? 'Internal data service is unavailable'
  if (!isInternalDashboardConfigured()) {
    return internalJson({ error: options.configurationMessage ?? 'Internal browser is unavailable' }, 503)
  }
  if (!hasValidInternalSession(session)) {
    return internalJson({ error: 'Unauthorized' }, 401)
  }

  try {
    const upstream = await fetch(`${internalApiBaseUrl()}${path}`, {
      headers: {
        Authorization: `Bearer ${expectedInternalToken()}`,
        Accept: 'application/json',
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    })

    if (!upstream.ok) {
      if (upstream.status === 404) {
        return internalJson({ error: options.notFoundMessage ?? 'Entity not found' }, 404)
      }
      return internalJson({ error: unavailableMessage }, 502)
    }

    return new NextResponse(await upstream.text(), {
      status: 200,
      headers: {
        ...INTERNAL_HEADERS,
        'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
      },
    })
  } catch {
    return internalJson({ error: unavailableMessage }, 502)
  }
}

export async function proxyInternalWriteApi(
  request: Request,
  path: string,
  options: InternalWriteProxyOptions = {},
): Promise<NextResponse> {
  const session = await getInternalSession()
  const writeToken = options.writeToken ?? ''
  const unavailableMessage = options.unavailableMessage ?? 'Internal Entity write service is unavailable'
  if (!isInternalDashboardConfigured() || !isStrongSecret(writeToken)) {
    return internalJson({ error: unavailableMessage }, 503)
  }
  if (!hasValidInternalSession(session)) return internalJson({ error: 'Unauthorized' }, 401)
  if (!requestHasTrustedOrigin(request)) return internalJson({ error: 'Invalid request origin' }, 403)

  const contentLength = Number(request.headers.get('content-length') ?? 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_WRITE_BODY_BYTES) {
    return internalJson({ error: 'Request payload is too large' }, 413)
  }
  const body = await request.text()
  if (Buffer.byteLength(body, 'utf8') > MAX_WRITE_BODY_BYTES) {
    return internalJson({ error: 'Request payload is too large' }, 413)
  }

  try {
    const upstream = await fetch(`${internalApiBaseUrl()}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${writeToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body,
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    })
    const passthroughStatuses = new Set(options.passthroughStatuses ?? [400, 409])
    if (!upstream.ok && !passthroughStatuses.has(upstream.status)) {
      return internalJson({ error: unavailableMessage }, 502)
    }
    return new NextResponse(await upstream.text(), {
      status: upstream.status,
      headers: {
        ...INTERNAL_HEADERS,
        'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
      },
    })
  } catch {
    return internalJson({ error: unavailableMessage }, 502)
  }
}

function createInternalSession(): string {
  const signingKey = sessionSigningKey()
  if (!signingKey) throw new Error('Internal dashboard is not configured')

  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS
  const nonce = randomBytes(18).toString('base64url')
  const payload = `v1.${expiresAt}.${nonce}`
  return `${payload}.${signSession(payload, signingKey)}`
}

function sessionSigningKey(): Buffer | null {
  if (!isInternalDashboardConfigured()) return null
  return createHmac('sha256', process.env.INTERNAL_DASHBOARD_SESSION_SECRET!)
    .update(expectedInternalToken())
    .digest()
}

function signSession(payload: string, signingKey: Buffer): string {
  return createHmac('sha256', signingKey).update(payload).digest('base64url')
}

function isStrongSecret(value: string): boolean {
  return Buffer.byteLength(value, 'utf8') >= MIN_SECRET_BYTES
}

function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}
