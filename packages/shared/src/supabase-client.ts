import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient, SupabaseClientOptions } from '@supabase/supabase-js'

/**
 * Default per-request timeout applied to every HTTP request a shared Supabase
 * client makes, so a slow or hung Supabase cannot stall a worker forever.
 */
export const DEFAULT_SUPABASE_FETCH_TIMEOUT_MS = 10_000

export function validateSupabaseFetchTimeoutMs(timeoutMs: number): void {
  if (!Number.isFinite(timeoutMs) || !Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Supabase fetch timeout must be a positive finite integer, got: ${timeoutMs}`)
  }
}

export type SupabaseFetchFailureCause = 'timeout' | 'aborted' | 'connection_refused' | 'other'

/**
 * Console-style logger receiving the one-line `[supabase] request failed`
 * warning emitted when a request through the timeout fetch rejects.
 */
export type SupabaseFetchLogger = (message: string) => void

export type CreateTimeoutFetchOptions = {
  /** Called with the failure line on every rejected request. Defaults to console.warn. */
  logger?: SupabaseFetchLogger
}

function fetchErrorName(error: unknown): string {
  if (error instanceof Error) return error.name
  const name = (error as { name?: unknown } | null)?.name
  return typeof name === 'string' ? name : ''
}

/**
 * Classify why a wrapped request rejected: our timeout signal fired
 * (TimeoutError), the caller aborted their signal, the connection was refused
 * (ECONNREFUSED surfaced by undici as error.cause.code), or something else.
 */
function classifyFetchFailure(error: unknown, callerSignal?: AbortSignal | null): SupabaseFetchFailureCause {
  if (fetchErrorName(error) === 'TimeoutError') return 'timeout'
  if (callerSignal?.aborted) return 'aborted'
  if ((error as { cause?: { code?: unknown } | null })?.cause?.code === 'ECONNREFUSED') return 'connection_refused'
  return 'other'
}

/**
 * The URL path of a failed request, without the host or query string, so log
 * lines never carry apikeys or other credentials in the query. Unparseable
 * inputs degrade to a placeholder instead of leaking an URL.
 */
function requestPathOf(input: RequestInfo | URL): string {
  try {
    const url = input instanceof URL ? input : new URL(input instanceof Request ? input.url : String(input))
    return url.pathname
  } catch {
    return '<unparsed>'
  }
}

function requestMethodOf(input: RequestInfo | URL, init?: RequestInit): string {
  return init?.method ?? (input instanceof Request ? input.method : 'GET')
}

/**
 * Wrap a base fetch so every request also aborts after timeoutMs. The caller's
 * init.signal (if any) stays connected: whichever fires first cancels the
 * request. Validation happens here, so a client built through this factory
 * fails at construction time, not on its first request.
 *
 * Every rejection is also reported as one console.warn line with the failure
 * cause, timeoutMs, method and request path only, and the original error is
 * rethrown unchanged.
 */
export function createTimeoutFetch(
  timeoutMs: number,
  baseFetch: typeof fetch = fetch,
  options: CreateTimeoutFetchOptions = {},
): typeof fetch {
  validateSupabaseFetchTimeoutMs(timeoutMs)
  const logger = options.logger ?? console.warn
  return async (input, init) => {
    try {
      return await baseFetch(input, {
        ...init,
        signal: init?.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      logger(`[supabase] request failed ${JSON.stringify({
        cause: classifyFetchFailure(error, init?.signal),
        timeoutMs,
        method: requestMethodOf(input, init),
        path: requestPathOf(input),
      })}`)
      throw error
    }
  }
}

export type CreateSupabaseClientOptions = {
  /** Per-request fetch timeout. Defaults to DEFAULT_SUPABASE_FETCH_TIMEOUT_MS. */
  timeoutMs?: number
  /** Base fetch to wrap. Defaults to the global fetch. */
  fetch?: typeof fetch
  /** Called with one `[supabase] request failed` line per rejected request. Defaults to console.warn. */
  logger?: SupabaseFetchLogger
  /** Extra options forwarded to supabase-js; session persistence flags and global.fetch stay forced by this factory. */
  clientOptions?: SupabaseClientOptions<string>
}

/**
 * Shared Supabase client factory for collectors workers: no persisted sessions
 * (workers hold a service-role key), no auto refresh, and every request
 * bounded by the timeout fetch. Returns an untyped SupabaseClient like the raw
 * createClient call sites it replaces.
 */
export function createSupabaseClient(
  supabaseUrl: string,
  supabaseKey: string,
  options?: CreateSupabaseClientOptions,
): SupabaseClient {
  const clientOptions = options?.clientOptions
  const timeoutMs = options?.timeoutMs ?? DEFAULT_SUPABASE_FETCH_TIMEOUT_MS
  return createClient(supabaseUrl, supabaseKey, {
    ...clientOptions,
    auth: {
      ...clientOptions?.auth,
      persistSession: false,
      autoRefreshToken: false,
    },
    global: {
      ...clientOptions?.global,
      fetch: createTimeoutFetch(timeoutMs, options?.fetch, { logger: options?.logger }),
    },
  }) as SupabaseClient
}