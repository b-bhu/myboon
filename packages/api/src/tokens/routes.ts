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
  /**
   * Upstream icon URL for an arbitrary mint (Jupiter-indexed long tail).
   * Optional so tests can build a service without it.
   */
  iconSourceUrlForMint?(mint: string): string | null
  /** Look up mints we do not know yet, so the next resolve returns identity. */
  warmMintIdentities?(mints: readonly string[]): Promise<void>
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

/**
 * Weak ETag over icon bytes. Icons carry a week-long max-age, which is right —
 * they almost never change — but without a validator a client that cached a
 * wrong image keeps it for that whole week with no way to notice. (That is not
 * hypothetical: USDC and USDT briefly served the same file, and fixing the
 * bytes did not fix already-cached browsers.) With an ETag the client
 * revalidates, gets a 304 in the normal case, and picks up new bytes the moment
 * they differ.
 */
function iconETag(bytes: Uint8Array, contentType: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < bytes.length; i += 1) {
    hash = Math.imul(hash ^ bytes[i], 0x01000193) >>> 0
  }
  return `W/"${hash.toString(36)}-${bytes.length.toString(36)}-${contentType.length.toString(36)}"`
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

  /**
   * Fill the mint cache before resolving, so a caller asking about a Meteora
   * pool leg (or any arbitrary mint) gets real identity on THIS response rather
   * than a letter box now and the real thing on some later call.
   *
   * Bounded and non-fatal: only mints we have no warm entry for are looked up,
   * and a failure just means those rows fall back — resolution below never
   * depends on it having succeeded.
   */
  async function warmUnknownMints(refs: readonly string[]): Promise<void> {
    if (!enabled || !service.warmMintIdentities) return
    const mints = refs
      .filter((ref) => ref.startsWith('mint:'))
      .map((ref) => ref.slice('mint:'.length).trim())
      .filter((mint) => mint.length > 0)
    if (mints.length === 0) return
    try {
      await service.warmMintIdentities(mints)
    } catch {
      // Identity decorates a row; it never blocks one.
    }
  }

  // GET /tokens/resolve?refs=<comma-separated> — max 100 refs.
  routes.get('/resolve', async (c) => {
    const refs = parseGetRefs(c.req.query('refs'))
    if (refs === null) {
      return c.json({ error: `Too many refs (max ${MAX_REFS_GET})` }, 400)
    }
    await warmUnknownMints(refs)
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

    await warmUnknownMints(refs as string[])
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
  // GET /tokens/icon/mint/:mint — icons for arbitrary SPL mints (Meteora pool
  // legs today; spot lists and meme feeds later). Registered BEFORE the
  // /icon/:assetId route so "mint" is not swallowed as an assetId.
  //
  // The upstream here is whatever host the token's own metadata points at —
  // IPFS, Arweave, a launchpad CDN. Caching the bytes on our side is the whole
  // point: the client gets one origin, and a slow gateway costs one server-side
  // miss rather than a broken row on every device.
  routes.get('/icon/mint/:mint', async (c) => {
    if (!enabled) return c.body(null, 404)

    const mint = c.req.param('mint')
    const result = await getIcon(`mint/${mint}`, () => service.iconSourceUrlForMint?.(mint) ?? null)
    if (!result) {
      return new Response(null, {
        status: 404,
        headers: { 'Cache-Control': ICON_MISS_CACHE_CONTROL },
      })
    }

    const etag = iconETag(result.bytes, result.contentType)
    if (c.req.header('if-none-match') === etag) {
      return c.body(null, 304, { etag, 'Cache-Control': result.cacheControl })
    }

    return new Response(result.bytes, {
      headers: {
        'Content-Type': result.contentType,
        'Cache-Control': result.cacheControl,
        ETag: etag,
      },
    })
  })

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

    const etag = iconETag(result.bytes, result.contentType)
    if (c.req.header('if-none-match') === etag) {
      return c.body(null, 304, { etag, 'Cache-Control': result.cacheControl })
    }

    return new Response(result.bytes, {
      headers: {
        'Content-Type': result.contentType,
        'Cache-Control': result.cacheControl,
        ETag: etag,
      },
    })
  })

  return routes
}
