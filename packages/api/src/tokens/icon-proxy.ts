// Generalized icon proxy, keyed on assetId. Generalized from the working
// Pacifica proxy at packages/api/src/pacifica.ts:127-166, which already does
// caching, negative caching, and Cache-Control.
//
// Upstream URLs are exact-cased icon_source_url values from the identity
// service seed/snapshot — never uppercased. Pacifica's icon CDN is
// case-sensitive (kPEPE.svg -> 200, KPEPE.svg -> 404); the legacy
// symbol-uppercasing proxy in pacifica.ts negative-cached Pacifica's kPEPE /
// kBONK / kSHIB icons as 404s. Resolving the upstream URL from the seed's
// exact casing instead of deriving it from an uppercased symbol is what
// fixes that.
//
// Cache entries hold raw bytes (not text) so both SVG and PNG upstreams work
// through one code path, with content-type passthrough.
//
// icon_source_url lookup: identity-service.ts is the single source of truth
// for this — its iconSourceUrlForAssetId(assetId) export is built on the
// same warm snapshot/seed maps that module already maintains for
// resolveRef(). This module does not keep its own copy of that data; the
// default lookup below just calls through to it. Callers (routes.ts) inject
// the lookup as a parameter, which also keeps this module testable without
// needing identity-service.ts's warm maps populated.

export const ICON_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000 // one week
export const ICON_NEGATIVE_TTL_MS = 60 * 60 * 1000 // one hour — a newly listed token must not be broken all day

/**
 * Transient failures (thrown fetch: DNS, timeout, connection reset) get a much
 * shorter TTL than a definitive answer. An upstream 404 means "there is no icon
 * here" and is worth remembering for an hour; a network blip means "we could not
 * find out", and caching that for an hour blanks the token app-wide long after
 * the network recovered. Same reasoning as the one-hour-not-one-day choice
 * above, one level down.
 */
export const ICON_TRANSIENT_TTL_MS = 60 * 1000 // one minute

interface IconCacheHit {
  bytes: Uint8Array
  contentType: string
  expiresAt: number
}

interface IconCacheMiss {
  bytes: null
  expiresAt: number
}

type IconCacheEntry = IconCacheHit | IconCacheMiss

const iconCache = new Map<string, IconCacheEntry>()

export interface IconFetchResult {
  bytes: Uint8Array
  contentType: string
  cacheControl: string
}

export type IconLookup = (assetId: string) => string | null | undefined | Promise<string | null | undefined>

type FetchLike = typeof fetch

/** Test-only escape hatch to reset module-level cache state between tests. */
export function __clearIconCacheForTest(): void {
  iconCache.clear()
}

/**
 * Icons checked in on disk, served before any network call is considered.
 *
 * `scripts/fetch-token-icons.ts` downloads the best available icon per asset
 * (the Tokens registry's canonical logo where it has one, the venue's
 * otherwise) into this directory. A token's logo does not change, so fetching
 * it once and serving bytes from disk removes the runtime dependency on both
 * upstreams entirely — no nightly job and no table needed just to hold icons.
 *
 * The network path below still exists as a fallback for anything not yet
 * downloaded (a newly listed token, or a fresh checkout before the script has
 * run), which keeps the proxy correct without making it depend on the network.
 */
const LOCAL_ICON_DIR = new URL('../../assets/token-icons/', import.meta.url)
const LOCAL_ICON_EXTENSIONS = ['svg', 'png', 'webp', 'jpg'] as const

const LOCAL_CONTENT_TYPES: Record<string, string> = {
  svg: 'image/svg+xml; charset=utf-8',
  png: 'image/png',
  webp: 'image/webp',
  jpg: 'image/jpeg',
}

/** Read a checked-in icon for this assetId, or null when we have no file. */
async function readLocalIcon(assetId: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  // assetIds are our own slugs, but never trust one into a path — a ref like
  // `mint:../../etc/passwd` reaches this function as an assetId.
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(assetId) || assetId.includes('..')) return null
  const { readFile } = await import('node:fs/promises')
  for (const ext of LOCAL_ICON_EXTENSIONS) {
    try {
      const bytes = new Uint8Array(await readFile(new URL(`${assetId}.${ext}`, LOCAL_ICON_DIR)))
      if (bytes.byteLength > 0) return { bytes, contentType: LOCAL_CONTENT_TYPES[ext] }
    } catch {
      // not on disk in this format — try the next extension
    }
  }
  return null
}

/**
 * Resolve icon bytes for an assetId. Returns null when the icon is unknown
 * or the upstream has no icon (negative-cached). Never throws — upstream
 * failures negative-cache the same as a 404, per the "unresolved is a 200
 * (or here, a clean 404 on our own icon route), not an error" rule.
 */
export async function getIcon(
  assetId: string,
  lookupSourceUrl: IconLookup,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<IconFetchResult | null> {
  const now = Date.now()
  const cached = iconCache.get(assetId)
  if (cached && cached.expiresAt > now) {
    if (cached.bytes === null) return null
    return {
      bytes: cached.bytes,
      contentType: cached.contentType,
      cacheControl: `public, max-age=${Math.floor(ICON_CACHE_TTL_MS / 1000)}`,
    }
  }

  // Disk first — see LOCAL_ICON_DIR. Cached in memory like any other hit, so a
  // given icon is read from disk once per process rather than per request.
  const local = await readLocalIcon(assetId)
  if (local) {
    iconCache.set(assetId, { ...local, expiresAt: now + ICON_CACHE_TTL_MS })
    return {
      ...local,
      cacheControl: `public, max-age=${Math.floor(ICON_CACHE_TTL_MS / 1000)}`,
    }
  }

  const sourceUrl = await lookupSourceUrl(assetId)
  if (!sourceUrl) {
    iconCache.set(assetId, { bytes: null, expiresAt: now + ICON_NEGATIVE_TTL_MS })
    return null
  }

  try {
    const res = await fetchImpl(sourceUrl)
    if (!res.ok) {
      iconCache.set(assetId, { bytes: null, expiresAt: now + ICON_NEGATIVE_TTL_MS })
      return null
    }

    const contentType = res.headers.get('content-type') ?? guessContentType(sourceUrl)
    const bytes = new Uint8Array(await res.arrayBuffer())
    iconCache.set(assetId, { bytes, contentType, expiresAt: now + ICON_CACHE_TTL_MS })
    return {
      bytes,
      contentType,
      cacheControl: `public, max-age=${Math.floor(ICON_CACHE_TTL_MS / 1000)}`,
    }
  } catch (err) {
    // Transient, not definitive — short TTL so a blip does not blank this icon
    // for an hour. See ICON_TRANSIENT_TTL_MS.
    console.error(`[api] Icon fetch for ${assetId} failed:`, err instanceof Error ? err.message : err)
    iconCache.set(assetId, { bytes: null, expiresAt: now + ICON_TRANSIENT_TTL_MS })
    return null
  }
}

function guessContentType(url: string): string {
  if (/\.svg(\?|$)/i.test(url)) return 'image/svg+xml; charset=utf-8'
  if (/\.png(\?|$)/i.test(url)) return 'image/png'
  if (/\.jpe?g(\?|$)/i.test(url)) return 'image/jpeg'
  if (/\.webp(\?|$)/i.test(url)) return 'image/webp'
  return 'application/octet-stream'
}

/** Cache-Control value served on a negative-cached (unknown/no-icon) response. */
export const ICON_MISS_CACHE_CONTROL = `public, max-age=${Math.floor(ICON_NEGATIVE_TTL_MS / 1000)}`
