import { Hono } from 'hono'
import type { Context } from 'hono'
import { getConnInfo } from '@hono/node-server/conninfo'
import {
  parseRpcPayload,
  rpcEndpointSecrets,
  rpcError,
  sanitizeRpcSecrets,
  type JsonRpcRequest,
  type RpcNetwork,
} from './policy.js'

export type RpcProxyEndpoints = {
  solanaRpcUrl: string
  solanaDevnetRpcUrl: string
  polygonRpcUrl: string
}

export type RpcRateLimiter = {
  consume: (identity: string, cost: number) => { ok: boolean; retryAfterSeconds: number }
}

export type RpcFetch = (input: string | URL, init?: RequestInit) => Promise<Response>

export type RpcRoutesOptions = RpcProxyEndpoints & {
  fetchImpl?: RpcFetch
  rateLimiter?: RpcRateLimiter
  trustForwardedHeaders?: boolean
  maxBodyBytes?: number
  maxResponseBytes?: number
  timeoutMs?: number
}

const DEFAULT_BODY_BYTES = 2 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 12_000
const DEFAULT_RESPONSE_BYTES = 8 * 1024 * 1024

export function createRpcRateLimiter(limit = 240, windowMs = 60_000): RpcRateLimiter {
  const buckets = new Map<string, { startedAt: number; used: number }>()
  return {
    consume(identity, cost) {
      const now = Date.now()
      const current = buckets.get(identity)
      const bucket = !current || now - current.startedAt >= windowMs
        ? { startedAt: now, used: 0 }
        : current
      if (bucket.used + cost > limit) {
        buckets.set(identity, bucket)
        return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((windowMs - (now - bucket.startedAt)) / 1000)) }
      }
      bucket.used += cost
      buckets.set(identity, bucket)
      if (buckets.size > 10_000) {
        for (const [key, item] of buckets) if (now - item.startedAt >= windowMs) buckets.delete(key)
      }
      return { ok: true, retryAfterSeconds: 0 }
    },
  }
}

function identityFromHeaders(request: Request, trustForwardedHeaders: boolean): string {
  if (!trustForwardedHeaders) return 'unknown'
  // The address is the quota identity. A caller-controlled session header is
  // deliberately not part of the key: otherwise a client could mint session
  // values to obtain unlimited per-IP quota. These forwarding headers are
  // only trusted when the deployment's proxy strips/replaces them.
  return request.headers.get('cf-connecting-ip')
    ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? 'unknown'
}

function identityFromContext(context: Context, trustForwardedHeaders: boolean): string {
  if (trustForwardedHeaders) return identityFromHeaders(context.req.raw, true)
  try {
    return getConnInfo(context).remote.address ?? 'unknown'
  } catch {
    // Hono's in-memory Request adapter has no socket context. Production
    // Node requests use getConnInfo; tests and other adapters share unknown.
    return 'unknown'
  }
}

function endpointFor(network: RpcNetwork, options: RpcRoutesOptions): string {
  return network === 'polygon'
    ? options.polygonRpcUrl
    : network === 'solana-devnet' ? options.solanaDevnetRpcUrl : options.solanaRpcUrl
}

function abortAfter(timeoutMs: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return { signal: controller.signal, cancel: () => clearTimeout(timer) }
}

async function readBody(request: Request, maxBodyBytes: number): Promise<unknown> {
  const declared = request.headers.get('content-length')
  if (declared && Number(declared) > maxBodyBytes) throw new Error('RPC request body is too large')
  const reader = request.body?.getReader()
  if (!reader) throw new Error('RPC request body is empty')
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > maxBodyBytes) {
        await reader.cancel()
        throw new Error('RPC request body is too large')
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown } catch { throw new Error('RPC request body is not valid JSON') }
}

async function readResponseText(response: Response, maxResponseBytes: number): Promise<string> {
  const declared = response.headers.get('content-length')
  if (declared && Number(declared) > maxResponseBytes) throw new Error('RPC upstream response is too large')
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > maxResponseBytes) {
        await reader.cancel()
        throw new Error('RPC upstream response is too large')
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

async function proxyRequest(
  request: Request,
  network: RpcNetwork,
  identity: string,
  options: RpcRoutesOptions,
): Promise<Response> {
  const id = null
  let payload: unknown
  try {
    payload = await readBody(request, options.maxBodyBytes ?? DEFAULT_BODY_BYTES)
  } catch (error) {
    return Response.json(rpcError(id, -32600, error instanceof Error ? error.message : 'Invalid Request'), { status: 400 })
  }
  const parsed = parseRpcPayload(payload, network)
  if (!Array.isArray(parsed)) return Response.json(parsed, { status: 400 })
  const limiter = options.rateLimiter ?? createRpcRateLimiter()
  const quota = limiter.consume(identity, parsed.length)
  if (!quota.ok) {
    return Response.json(rpcError(null, -32005, 'RPC rate limit exceeded'), {
      status: 429,
      headers: { 'Retry-After': String(quota.retryAfterSeconds) },
    })
  }
  const endpoint = endpointFor(network, options)
  const timeout = abortAfter(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    const upstream = await (options.fetchImpl ?? fetch)(endpoint, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: timeout.signal,
    })
    const text = await readResponseText(upstream, options.maxResponseBytes ?? DEFAULT_RESPONSE_BYTES)
    let body: unknown
    try { body = JSON.parse(text) as unknown } catch { body = null }
    if (body === null) {
      return Response.json(rpcError(null, -32002, 'RPC upstream returned invalid JSON'), { status: 502 })
    }
    const sanitized = sanitizeRpcSecrets(body, rpcEndpointSecrets(endpoint))
    const isJsonRpcEnvelope = Array.isArray(body)
      ? body.length > 0 && body.every((entry) => !!entry && typeof entry === 'object' && (entry as Record<string, unknown>).jsonrpc === '2.0')
      : !!body && typeof body === 'object' && (body as Record<string, unknown>).jsonrpc === '2.0'
    return Response.json(sanitized, { status: upstream.ok || isJsonRpcEnvelope ? 200 : 502 })
  } catch (error) {
    const message = error instanceof Error && error.name === 'AbortError'
      ? 'RPC upstream timed out'
      : 'RPC upstream is unavailable'
    return Response.json(rpcError(null, -32001, message), { status: 502 })
  } finally {
    timeout.cancel()
  }
}

export function createRpcRoutes(options: RpcRoutesOptions): Hono {
  const routes = new Hono()
  const routeOptions = { ...options, rateLimiter: options.rateLimiter ?? createRpcRateLimiter() }
  const identityFor = (c: Context) => identityFromContext(c, options.trustForwardedHeaders === true)
  routes.post('/solana', (c) => proxyRequest(c.req.raw, 'solana', identityFor(c), routeOptions))
  routes.post('/solana-devnet', (c) => proxyRequest(c.req.raw, 'solana-devnet', identityFor(c), routeOptions))
  routes.post('/polygon', (c) => proxyRequest(c.req.raw, 'polygon', identityFor(c), routeOptions))
  routes.all('*', (c) => c.json(rpcError(null, -32601, 'RPC route is not available'), 404))
  return routes
}

export type { JsonRpcRequest }
