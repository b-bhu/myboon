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

/**
 * Wrap a base fetch so every request also aborts after timeoutMs. The caller's
 * init.signal (if any) stays connected: whichever fires first cancels the
 * request. Validation happens here, so a client built through this factory
 * fails at construction time, not on its first request.
 */
export function createTimeoutFetch(timeoutMs: number, baseFetch: typeof fetch = fetch): typeof fetch {
  validateSupabaseFetchTimeoutMs(timeoutMs)
  return (input, init) => baseFetch(input, {
    ...init,
    signal: init?.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs),
  })
}

export type CreateSupabaseClientOptions = {
  /** Per-request fetch timeout. Defaults to DEFAULT_SUPABASE_FETCH_TIMEOUT_MS. */
  timeoutMs?: number
  /** Base fetch to wrap. Defaults to the global fetch. */
  fetch?: typeof fetch
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
      fetch: createTimeoutFetch(timeoutMs, options?.fetch),
    },
  }) as SupabaseClient
}