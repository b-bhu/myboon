// --- Polymarket Data API v2 helper (issue #426) ---
// v2 base: https://data-api.polymarket.com/v2/<route>. Every response is
// {"data": ...}; paginated routes add {"pagination": {"next_cursor": ...}}.
// A miss arrives as data:null (or an empty array). v2 rejects the v1 paging
// params (offset, market, market_id, marketId) with HTTP 400 and pages via
// `cursor` instead. All field names are snake_case on the wire.

import { z } from 'zod'

const DATA_API_BASE = 'https://data-api.polymarket.com'

/** Params the v2 API rejects with HTTP 400 (v1-only vocabulary). */
const REJECTED_PARAMS = new Set(['offset', 'market', 'market_id', 'marketId'])

/** Typed failure for data-api v2 calls; HTTP failures carry the upstream status. */
export class DataApiV2Error extends Error {
  readonly route: string
  readonly status: number

  constructor(route: string, status: number, message: string) {
    super(message)
    this.name = 'DataApiV2Error'
    this.route = route
    this.status = status
  }
}

/** Thrown before a request is sent when params carry v1-only vocabulary. */
export class DataApiV2ParamError extends DataApiV2Error {
  readonly param: string

  constructor(route: string, param: string) {
    super(route, 400, `data-api v2 /${route} rejects the "${param}" parameter (v2 pages by cursor)`)
    this.name = 'DataApiV2ParamError'
    this.param = param
  }
}

export type DataApiV2Params = Record<string, string>

/** Injected for tests; defaults to the global fetch. */
export type DataApiV2Fetch = typeof globalThis.fetch

const dataApiV2ListEnvelopeSchema = z.object({
  data: z.array(z.record(z.string(), z.unknown())).nullable(),
  pagination: z
    .object({
      next_cursor: z.string().nullable().optional(),
    })
    .optional(),
})

const dataApiV2GetEnvelopeSchema = z.object({
  data: z.unknown().nullable(),
})

export interface DataApiV2ListOptions {
  /** Stop walking (and truncate to) this many rows. Default: until the cursor ends. */
  cap?: number
  fetch?: DataApiV2Fetch
}

export interface DataApiV2GetOptions {
  fetch?: DataApiV2Fetch
}

function normalizeRoute(route: string): string {
  return route.replace(/^\/+/, '')
}

function assertAcceptedParams(route: string, params: DataApiV2Params): void {
  for (const key of Object.keys(params)) {
    if (REJECTED_PARAMS.has(key)) throw new DataApiV2ParamError(route, key)
  }
}

function buildUrl(route: string, params: DataApiV2Params, cursor: string | null): string {
  const search = new URLSearchParams(params)
  if (cursor) search.set('cursor', cursor)
  const query = search.toString()
  return `${DATA_API_BASE}/v2/${route}${query ? `?${query}` : ''}`
}

async function readEnvelope<T>(route: string, res: Response, schema: z.ZodType<T>): Promise<T> {
  let body: unknown
  try {
    body = await res.json()
  } catch {
    throw new DataApiV2Error(route, 0, `data-api v2 /${route} returned a non-JSON body`)
  }
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ')
    throw new DataApiV2Error(route, 0, `data-api v2 /${route} returned an unexpected envelope${issues ? ` (${issues})` : ''}`)
  }
  return parsed.data
}

/**
 * GET `${DATA_API_BASE}/v2/<route>` for a list route: unwraps the
 * `{"data": ...}` envelope (data:null -> []), walks `pagination.next_cursor`
 * until it is null or `cap` rows were collected, and truncates to `cap`.
 * Inject `fetch` in tests; defaults to the global fetch.
 */
export async function dataApiV2List(
  route: string,
  params: DataApiV2Params = {},
  options: DataApiV2ListOptions = {},
): Promise<Record<string, unknown>[]> {
  const path = normalizeRoute(route)
  assertAcceptedParams(path, params)
  const cap = options.cap ?? Number.POSITIVE_INFINITY
  const doFetch: DataApiV2Fetch = options.fetch ?? globalThis.fetch

  const rows: Record<string, unknown>[] = []
  let cursor: string | null = null
  // A well-behaved server ends with next_cursor:null; a cursor that keeps
  // repeating would otherwise walk forever, so stop when it repeats.
  while (true) {
    const res: Response = await doFetch(buildUrl(path, params, cursor))
    if (!res.ok) {
      throw new DataApiV2Error(path, res.status, `data-api v2 /${path} responded HTTP ${res.status}`)
    }

    const envelope = await readEnvelope(path, res, dataApiV2ListEnvelopeSchema)
    rows.push(...(envelope.data ?? []))

    const nextCursor: string | null = envelope.pagination?.next_cursor ?? null
    if (!nextCursor || nextCursor === cursor || rows.length >= cap) break
    cursor = nextCursor
  }

  return rows.slice(0, cap)
}

/**
 * GET `${DATA_API_BASE}/v2/<route>` for a single-object route: unwraps the
 * `{"data": ...}` envelope and returns the payload (null on a miss).
 */
export async function dataApiV2Get<T = Record<string, unknown>>(
  route: string,
  params: DataApiV2Params = {},
  options: DataApiV2GetOptions = {},
): Promise<T | null> {
  const path = normalizeRoute(route)
  assertAcceptedParams(path, params)
  const doFetch: DataApiV2Fetch = options.fetch ?? globalThis.fetch

  const res: Response = await doFetch(buildUrl(path, params, null))
  if (!res.ok) {
    throw new DataApiV2Error(path, res.status, `data-api v2 /${path} responded HTTP ${res.status}`)
  }

  const envelope = await readEnvelope(path, res, dataApiV2GetEnvelopeSchema)
  return (envelope.data ?? null) as T | null
}