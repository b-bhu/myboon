export const DEFAULT_PACIFICA_API_BASE = 'https://api.pacifica.fi/api/v1'

// Upstream calls from the wallet summary share this timeout; the summary
// service races each app at 8s, so the upstream call gives up no later.
const PACIFICA_TIMEOUT_MS = 8_000

/**
 * Error from a Pacifica upstream call. `status` is the HTTP status (or the
 * upstream `code` for a `success: false` body), null for network/timeout
 * failures; `retryAfter` carries the retry hint (seconds, as sent) when the
 * upstream told us to back off.
 */
export class PacificaApiError extends Error {
  readonly status: number | null
  readonly retryAfter: string | null

  constructor(message: string, status: number | null, retryAfter: string | null = null) {
    super(message)
    this.name = 'PacificaApiError'
    this.status = status
    this.retryAfter = retryAfter
  }
}

// The retry hint, when the response carries one: `retry-after` wins, else the
// `t=` reset seconds in the IETF `ratelimit` header ("credits";r=0;t=23).
function retryHint(headers: Headers): string | null {
  const retryAfter = headers.get('retry-after')
  if (retryAfter) return retryAfter
  const ratelimit = headers.get('ratelimit')
  const reset = ratelimit?.match(/(?:^|;)\s*t=(\d+)/)?.[1]
  return reset ?? null
}

export interface PacificaClient {
  getJson<T>(path: string): Promise<T>
}

export interface PacificaClientOptions {
  /** PACIFICA_API_BASE, read in bootstrap/config.ts; unset or empty keeps the default. */
  apiBase?: string
}

export function createPacificaClient(options: PacificaClientOptions = {}): PacificaClient {
  const apiBase = options.apiBase || DEFAULT_PACIFICA_API_BASE

  return {
    async getJson<T>(path: string): Promise<T> {
      let res: Response
      try {
        res = await fetch(`${apiBase}${path}`, { signal: AbortSignal.timeout(PACIFICA_TIMEOUT_MS) })
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        throw new PacificaApiError(`Pacifica ${path} failed: ${detail}`, null)
      }

      if (res.status === 429) {
        const retryAfter = retryHint(res.headers)
        throw new PacificaApiError(
          `Pacifica ${path} rate limited${retryAfter ? ` (retry after ${retryAfter}s)` : ''}`,
          429,
          retryAfter,
        )
      }
      if (!res.ok) throw new PacificaApiError(`Pacifica ${path} failed (${res.status})`, res.status)

      const json = await res.json() as { success?: boolean; data?: T; error?: string; message?: string; code?: number | null }
      if (json.success === false) {
        const status = typeof json.code === 'number' ? json.code : null
        throw new PacificaApiError(json.error ?? json.message ?? `Pacifica ${path} failed`, status)
      }
      return json.data as T
    },
  }
}

// The wallet summary's Pacifica venue is a module-level constant, so it reads
// through this shared client. createApp points it at the configured base
// (configurePacificaClient, same shape as the #833 configure* calls); until
// then it uses the default base.
let sharedClient = createPacificaClient()

export function configurePacificaClient(options: PacificaClientOptions): void {
  sharedClient = createPacificaClient(options)
}

export function pacificaGetJson<T>(path: string): Promise<T> {
  return sharedClient.getJson<T>(path)
}
