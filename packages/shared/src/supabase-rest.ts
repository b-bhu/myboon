import { DEFAULT_SUPABASE_FETCH_TIMEOUT_MS } from './supabase-client.js'

/**
 * Options for the one Supabase REST (PostgREST) read helper (#832): it builds
 * the rest/v1 URL, the apikey/Authorization headers, the optional atlas
 * Accept-Profile header and the request timeout once, so API call sites stop
 * hand-rolling fetch.
 */
export type SupabaseRestOptions = {
  supabaseUrl: string
  serviceRoleKey: string
  /** Test injection; defaults to globalThis.fetch. */
  fetch?: typeof fetch
  /** Request timeout; defaults to 10 seconds like the supabase-js client. */
  timeoutMs?: number
}

/**
 * One way to read rows (and row counts) from Supabase PostgREST. Requests
 * `GET <supabaseUrl>/rest/v1/<table>?<params>` with the service-role headers
 * and a timeout signal; only the atlas schema adds the Accept-Profile header.
 */
export function createSupabaseRest(o: SupabaseRestOptions): {
  readRows<T>(table: string, params: URLSearchParams, schema?: 'atlas'): Promise<T[]>
  readCount(table: string, params: URLSearchParams, schema?: 'atlas'): Promise<number>
} {
  const fetchImpl = o.fetch ?? globalThis.fetch
  const timeoutMs = o.timeoutMs ?? DEFAULT_SUPABASE_FETCH_TIMEOUT_MS
  const restBaseUrl = `${o.supabaseUrl.replace(/\/$/, '')}/rest/v1`

  function restUrl(table: string, params: URLSearchParams): URL {
    const url = new URL(`${restBaseUrl}/${table}`)
    params.forEach((value, key) => url.searchParams.append(key, value))
    return url
  }

  function restHeaders(schema?: 'atlas'): Record<string, string> {
    return {
      apikey: o.serviceRoleKey,
      Authorization: `Bearer ${o.serviceRoleKey}`,
      Accept: 'application/json',
      // PostgREST schema select: only the atlas source switches the profile header.
      ...(schema === 'atlas' ? { 'Accept-Profile': 'atlas' } : {}),
    }
  }

  /** A Content-Range total like `0-0/42`; `0-0/*` (unknown) and unparseable values are not a count. */
  function contentRangeTotal(value: string | null): number | null {
    if (!value) return null
    const total = value.split('/')[1]
    if (!total || !/^\d+$/.test(total)) return null
    const parsed = Number(total)
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
  }

  return {
    async readRows<T>(table: string, params: URLSearchParams, schema?: 'atlas'): Promise<T[]> {
      const response = await fetchImpl(restUrl(table, params), {
        headers: restHeaders(schema),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) {
        throw new Error(`Supabase read failed for ${table}: ${response.status}`)
      }
      const body: unknown = await response.json()
      if (!Array.isArray(body)) throw new Error(`Supabase returned an invalid ${table} response`)
      return body as T[]
    },

    /** Total row count for `params` via one `Prefer: count=exact` read of the first row (`Range: 0-0`). */
    async readCount(table: string, params: URLSearchParams, schema?: 'atlas'): Promise<number> {
      const response = await fetchImpl(restUrl(table, params), {
        headers: { ...restHeaders(schema), Prefer: 'count=exact', Range: '0-0' },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) {
        throw new Error(`Supabase read failed for ${table}: ${response.status}`)
      }
      const total = contentRangeTotal(response.headers.get('Content-Range'))
      if (total === null) throw new Error(`Supabase returned an invalid ${table} count`)
      return total
    },
  }
}
