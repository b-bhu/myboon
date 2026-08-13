// Token identity HTTP routes: GET/POST /resolve and GET /icon/:assetId.
//
// Flag off: /resolve still answers well-formed TokenIdentity[] (assetId
// null, iconUrl null, source 'static') and /icon/* 404s. Nothing throws,
// nothing 500s — the identity service itself already degrades this way
// (resolveRef is pure/synchronous and always returns a TokenIdentity), so
// the flag here only gates the icon proxy's upstream fetch, matching the
// PRD's "one feature flag and one env var" acceptance criterion.
//
// Unresolved is always a 200, never a 4xx/5xx (see identity-service.ts and
// the PRD's "Unresolved is a 200, not an error" risk note) — a ref this
// service cannot resolve is still a well-formed identity with empty fields,
// not a client-facing error.

import { Hono } from 'hono'
import type { TokenIdentity } from './types.js'
import { fallbackLetter, parseTokenRef } from './types.js'
import { getIcon, ICON_MISS_CACHE_CONTROL } from './icon-proxy.js'

const MAX_REFS_GET = 100
const MAX_REFS_POST = 500

/** Catalog cache lifetime. Identity is static; days is the right order. */
const CATALOG_MAX_AGE_S = 3 * 24 * 60 * 60

export interface TokenIdentityService {
  resolveRef(ref: string): TokenIdentity
  /**
   * Resolve the exact-cased upstream icon source URL for an assetId.
   * identity-service.ts's iconSourceUrlForAssetId is the single source of
   * truth for this — injected here (rather than imported directly) so
   * routes.ts stays testable without identity-service.ts's warm maps
   * populated.
   */
  iconSourceUrlForAssetId(assetId: string): string | null
  /** Every resolvable ref, for the one-shot catalog. */
  resolveCatalog(): TokenIdentity[]
}

/**
 * Weak ETag over the catalog body. Cheap non-cryptographic hash — this is a
 * cache validator, not a security boundary, and it only has to change when the
 * bytes change.
 */
function catalogETag(body: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < body.length; i += 1) {
    const c = body.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 + c + 1, 0x85ebca6b) >>> 0
  }
  return `W/"${h1.toString(36)}${h2.toString(36)}-${body.length.toString(36)}"`
}

export interface CreateTokenRoutesConfig {
  enabled: boolean
  service: TokenIdentityService
}

function staticUnresolvedIdentity(ref: string): TokenIdentity {
  // Mirrors identity-service.ts's own static fallback shape for the
  // flag-off path: well-formed, assetId null, iconUrl null, source
  // 'static'. We do not call into resolveRef() here so flag-off never
  // depends on the (also flag-gated) icon proxy or snapshot state.
  //
  // The ref still has to be PARSED for its display symbol rather than used
  // raw. Deriving the letter from the whole ref gives every perp row a 'P'
  // (from "perp:") and every spot row an 'M' (from "mint:"), which breaks
  // acceptance criterion 3 — the fallback box must be identical whether the
  // flag is on or off, and flag-on parses the ref.
  const parsed = parseTokenRef(ref)
  const symbol = parsed.kind === 'perp' ? parsed.symbol : parsed.kind === 'mint' ? parsed.mint : parsed.raw
  return {
    key: ref,
    assetId: null,
    symbol,
    name: symbol,
    iconUrl: null,
    decimals: null,
    mint: parsed.kind === 'mint' ? parsed.mint : null,
    verified: false,
    category: 'unknown',
    fallbackLetter: fallbackLetter(symbol),
    source: 'static',
  }
}

function parseGetRefs(raw: string | undefined): string[] | null {
  if (!raw) return []
  const refs = raw.split(',').map((ref) => ref.trim()).filter((ref) => ref.length > 0)
  if (refs.length > MAX_REFS_GET) return null
  return refs
}

export function createTokenRoutes(config: CreateTokenRoutesConfig): Hono {
  const routes = new Hono()
  const { enabled, service } = config

  function resolveOne(ref: string): TokenIdentity {
    if (!enabled) return staticUnresolvedIdentity(ref)
    return service.resolveRef(ref)
  }

  // GET /tokens/resolve?refs=<comma-separated> — max 100 refs.
  routes.get('/resolve', (c) => {
    const refs = parseGetRefs(c.req.query('refs'))
    if (refs === null) {
      return c.json({ error: `Too many refs (max ${MAX_REFS_GET})` }, 400)
    }
    const identities = refs.map(resolveOne)
    return c.json({ identities })
  })

  // POST /tokens/resolve { refs: string[] } — max 500 refs.
  routes.post('/resolve', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    const refs = (body as { refs?: unknown } | null)?.refs
    if (!Array.isArray(refs) || !refs.every((ref) => typeof ref === 'string')) {
      return c.json({ error: 'Body must be { refs: string[] }' }, 400)
    }
    if (refs.length > MAX_REFS_POST) {
      return c.json({ error: `Too many refs (max ${MAX_REFS_POST})` }, 400)
    }

    const identities = (refs as string[]).map(resolveOne)
    return c.json({ identities })
  })

  // GET /tokens/catalog — every resolvable identity in one response.
  //
  // The client fetches this once and reads every market row's identity out of
  // it, instead of resolving per screen (which round-tripped for tokens two
  // venues share). Identity is static, so it carries a multi-day max-age plus
  // an ETag: a warm client revalidates into a 304 with no body, and a changed
  // catalog invalidates itself. No client-side cache bookkeeping needed — the
  // platform's HTTP cache does the storing.
  routes.get('/catalog', (c) => {
    const identities = enabled ? service.resolveCatalog() : []
    const body = JSON.stringify({ identities })
    const etag = catalogETag(body)

    // Revalidation: unchanged catalog costs a 304 and no payload.
    if (c.req.header('if-none-match') === etag) {
      return c.body(null, 304, {
        etag,
        'cache-control': `public, max-age=${CATALOG_MAX_AGE_S}`,
      })
    }

    return c.body(body, 200, {
      'content-type': 'application/json; charset=UTF-8',
      etag,
      'cache-control': `public, max-age=${CATALOG_MAX_AGE_S}`,
    })
  })

  // GET /tokens/icon/:assetId — image bytes. 404 on unknown/no-icon, and
  // whenever the flag is off (no third-party fetch happens in that state).
  routes.get('/icon/:assetId', async (c) => {
    if (!enabled) return c.body(null, 404)

    const assetId = c.req.param('assetId')
    const result = await getIcon(assetId, service.iconSourceUrlForAssetId)
    if (!result) {
      return new Response(null, {
        status: 404,
        headers: { 'Cache-Control': ICON_MISS_CACHE_CONTROL },
      })
    }

    return new Response(result.bytes, {
      headers: {
        'Content-Type': result.contentType,
        'Cache-Control': result.cacheControl,
      },
    })
  })

  return routes
}
