import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { lookup } from 'node:dns/promises'
import { isIP, type LookupFunction } from 'node:net'

const DEFAULT_MAX_REDIRECTS = 5
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024

export type ResolveHost = (hostname: string) => Promise<string[]>

export interface SafePublicDocument {
  body: Buffer
  finalUrl: string
  contentType: string | null
  status: number
  /** Every externally contacted hostname, for browser fallback containment. */
  visitedHosts: string[]
}

export interface SafePublicFetchOptions {
  timeoutMs: number
  maxBytes?: number
  maxRedirects?: number
  /**
   * Optional redirect-safe host policy. A destination is rejected before DNS
   * resolution or connection unless its hostname is this domain or one of its
   * subdomains. Empty means no destination is approved.
   */
  allowedDomains?: string[]
  resolveHost?: ResolveHost
  requestImpl?: (url: URL, address: string, timeoutMs: number, maxBytes: number) => Promise<SafePublicHopResponse>
}

export interface SafePublicHopResponse {
  status: number
  contentType: string | null
  body: Buffer
  redirectUrl: string | null
}

/**
 * Fetches public HTTP(S) content without automatic redirects. Every hop is
 * resolved and checked before connection, and the chosen public address is
 * pinned into the request lookup callback to prevent DNS rebinding between
 * validation and connect.
 */
export async function fetchPublicDocument(
  rawUrl: string,
  options: SafePublicFetchOptions,
): Promise<SafePublicDocument> {
  const resolveHost = options.resolveHost ?? resolveAddresses
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const requestImpl = options.requestImpl ?? requestPinned
  const deadline = Date.now() + options.timeoutMs
  let current = parseHttpUrl(rawUrl)
  const visitedHosts: string[] = []

  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) throw timeoutError('Safe article fetch timed out')
    const hostname = normalizedHostname(current)
    if (options.allowedDomains && !isAllowedHostname(hostname, options.allowedDomains)) {
      throw new Error(`Article URL host is outside the approved domain policy: ${hostname}`)
    }
    const addresses = isIP(hostname) ? [hostname] : await resolveHost(hostname)
    const publicAddresses = addresses.filter(isPublicAddress)
    if (addresses.length === 0 || publicAddresses.length !== addresses.length) {
      throw new Error('Article URL resolved to a non-public address')
    }
    const address = publicAddresses[0]
    if (!visitedHosts.includes(hostname)) visitedHosts.push(hostname)

    const response = await requestImpl(current, address, remainingMs, maxBytes)
    if (!response.redirectUrl) {
      return {
        body: response.body,
        finalUrl: current.toString(),
        contentType: response.contentType,
        status: response.status,
        visitedHosts,
      }
    }
    if (redirects === maxRedirects) throw new Error(`Article exceeded ${maxRedirects} redirects`)
    current = parseHttpUrl(new URL(response.redirectUrl, current).toString())
  }

  throw new Error('Article redirect handling failed')
}

export function isAllowedHostname(hostname: string, allowedDomains: string[]): boolean {
  const normalizedHost = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  return allowedDomains.some((rawDomain) => {
    const domain = rawDomain.trim().replace(/^\*\./, '').replace(/\.$/, '').toLowerCase()
    return domain.length > 0 && (normalizedHost === domain || normalizedHost.endsWith(`.${domain}`))
  })
}

export function parseHttpUrl(rawUrl: string): URL {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('Article URL is invalid')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Article URL must use http or https')
  }
  if (url.username || url.password) throw new Error('Article URL must not include credentials')
  const hostname = normalizedHostname(url)
  if (hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')) {
    throw new Error('Article URL host is not public')
  }
  return url
}

function requestPinned(url: URL, address: string, timeoutMs: number, maxBytes: number): Promise<SafePublicHopResponse> {
  return new Promise((resolve, reject) => {
    const family = isIP(address)
    const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
      if (typeof options === 'object' && options.all) {
        callback(null, [{ address, family }])
      } else {
        callback(null, address, family)
      }
    }
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      headers: {
        accept: 'text/markdown,text/html;q=0.9,text/plain;q=0.8,*/*;q=0.2',
        'accept-encoding': 'identity',
        'user-agent': 'myboon-news-research/1.0',
      },
      lookup: pinnedLookup,
    }, (response) => {
      void consumeResponse(response, url, maxBytes).then(resolve, reject)
    })
    request.setTimeout(timeoutMs, () => request.destroy(timeoutError('Safe article fetch timed out')))
    request.once('error', reject)
    request.end()
  })
}

async function consumeResponse(response: IncomingMessage, requestUrl: URL, maxBytes: number): Promise<SafePublicHopResponse> {
  const status = response.statusCode ?? 0
  const location = response.headers.location
  if (isRedirect(status) && location) {
    response.resume()
    return {
      status,
      contentType: headerValue(response.headers['content-type']),
      body: Buffer.alloc(0),
      redirectUrl: new URL(location, requestUrl).toString(),
    }
  }

  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of response) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > maxBytes) {
      response.destroy()
      throw new Error(`Article response exceeded ${maxBytes} bytes`)
    }
    chunks.push(buffer)
  }
  return {
    status,
    contentType: headerValue(response.headers['content-type']),
    body: Buffer.concat(chunks),
    redirectUrl: null,
  }
}

function normalizedHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
}

async function resolveAddresses(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true })
  return records.map((record) => record.address)
}

function isPublicAddress(address: string): boolean {
  const version = isIP(address)
  if (version === 4) {
    const [a, b, c] = address.split('.').map(Number)
    return !(a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113)
      || a >= 224)
  }
  if (version === 6) {
    const normalized = address.toLowerCase()
    if (normalized === '::' || normalized === '::1') return false
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return false
    if (/^fe[89ab]/.test(normalized)) return false
    if (normalized.startsWith('ff')) return false
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1]
    if (mapped) return isPublicAddress(mapped)
    const mappedHex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
    if (mappedHex) return isPublicAddress(hexPairToIpv4(mappedHex[1], mappedHex[2]))
    return true
  }
  return false
}

function hexPairToIpv4(high: string, low: string): string {
  const value = (Number.parseInt(high, 16) * 0x10000) + Number.parseInt(low, 16)
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join('.')
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

function headerValue(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null
}

function timeoutError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: 'ETIMEDOUT' })
}
