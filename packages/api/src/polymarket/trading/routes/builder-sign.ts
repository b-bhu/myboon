import type { Hono } from 'hono'
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { verifyPredictAuthProof } from '../auth-proof.js'

/**
 * Remote Builder signing for `@polymarket/client`'s `SecureClient`, running
 * on the phone (see docs/modules/polymarket/PRDs/2026_07_31_polymarket_sdk_migration_PRD.md).
 *
 * The SDK needs `apiKey: builderApiKey({ key, secret, passphrase })` to
 * authorize gasless deposit-wallet deployment — confirmed on-device:
 * `createSecureClient` throws "Deposit Wallet deployment requires a Relayer
 * API Key or Builder API Key in the client configuration" without it.
 * `builderApiKey` embeds the raw secret in the client that calls it, which
 * is correct for a trusted server process but wrong for a phone app bundle —
 * the Builder secret authorizes gasless relaying for this app's entire
 * account, not scoped per user, and must not ship to every device.
 *
 * `remoteBuilderSigning({ url })` is the SDK's documented alternative for
 * exactly this: the client POSTs `{ method, path, body }` here, this route
 * signs with the secret it already holds (`POLYMARKET_BUILDER_SECRET`) and
 * returns the four `POLY_BUILDER_*` fields. The secret never leaves the
 * server, and the passphrase field is a non-secret server-injection marker;
 * the proxy inserts the real passphrase only on the verified upstream hop.
 * HMAC scheme matches `@polymarket/client`'s own `buildHmacSignature`
 * (verified against its compiled source): message is
 * `timestamp + method + requestPath [+ body]`, secret is base64-decoded,
 * HMAC-SHA256, output re-encoded base64url.
 *
 * ## Why this route is authenticated
 *
 * Keeping the secret server-side protects the *credential*; it does nothing
 * to protect the *capability* it grants. An unauthenticated route here is a
 * public signing oracle: anyone who finds the URL gets valid, signed
 * authorization billed to this app's Builder account. Polymarket caps the
 * blast radius by tier (100 relayer txns/day Unverified, 10,000 Verified —
 * https://docs.polymarket.com/programs/builders/tiers), so the realistic
 * harm is quota exhaustion that locks real users out of onboarding, plus
 * abuse traced back to this app's Builder profile.
 *
 * There is no account system to authenticate against — the app is open and
 * wallet-based — so this uses the same proof the rest of the Polymarket
 * surface already uses: the caller signs a timestamped message with their
 * EOA, and `verifyPredictAuthProof` recovers the address from the signature.
 * That deliberately does not prove the caller is a *legitimate* user —
 * anyone can make a wallet — it makes each request attributable and
 * rate-limitable per address, which turns costless anonymous abuse into
 * something bounded and traceable.
 *
 * The proof travels in headers rather than the body because the SDK owns
 * the body shape (`{ method, path, body }`) and calls the `headers` callback
 * fresh on every `authorize()`, which is the extension point it provides
 * for exactly this.
 */

/**
 * Relayer and CLOB operations the SDK legitimately needs signed.
 *
 * `GET /deployed` (does this signer's deposit wallet exist) and
 * `POST /submit` (execute a gasless transaction) are relayer calls.
 *
 * The create/derive `/auth` entries are one CLOB operation, not two. `@polymarket/client`
 * obtains CLOB credentials through a create-then-derive fallback — from its
 * compiled source:
 *
 *     try { return await Tc(e, r) }   // POST /auth/api-key
 *     catch (t) { if (!(t instanceof f) || t.status !== 400) throw t }
 *     return xc(e, r)                 // GET /auth/derive-api-key
 *
 * A signer with no key yet takes the POST and stops there. A signer that
 * already has one gets a 400 from Polymarket ("key exists"), and the SDK falls
 * back to the GET to fetch the existing credentials. So the POST is the
 * first-time path and the GET is the *returning user* path — allowlisting only
 * the POST leaves every account broken from its second setup onward, which is
 * what issue #275 was (a returning wallet 403'd on the fallback, surfacing as
 * the SDK's generic "Could not authorize the builder-authenticated request").
 * `/auth/api-keys` is used to validate credentials restored from SecureStore.
 * Fixed-host GETs are treated as reads, so new SDK metadata/reconciliation
 * endpoints do not require a deploy merely to restore an account. Writes stay
 * explicitly enumerated: credential create/revoke, order post/cancel, and
 * relayer submit.
 *
 * Write allowlisting means a stolen or replayed proof still cannot direct this
 * app's Builder credential at arbitrary state-changing operations.
 *
 * If a future SDK version adds a state-changing endpoint, it fails closed with
 * a structured policy refusal. New reads remain constrained by the proxies'
 * fixed Polymarket hosts and cannot select an arbitrary upstream.
 */
const ALLOWED_BUILDER_WRITES: ReadonlyArray<{ method: string; path: RegExp }> = [
  { method: 'POST', path: /^\/submit$/ },
  { method: 'POST', path: /^\/auth\/api-key$/ },
  { method: 'POST', path: /^\/order$/ },
  { method: 'DELETE', path: /^\/order$/ },
  { method: 'DELETE', path: /^\/auth\/api-key$/ },
]

/**
 * `remoteBuilderSigning` requires all four `POLY_BUILDER_*` fields to be
 * strings, including the passphrase. The real passphrase must never leave the
 * API, so the phone receives this non-secret marker. Our CLOB/Relayer proxies
 * replace it only after validating the accompanying Builder HMAC against the
 * exact method, path, and body being forwarded.
 */
export const SERVER_INJECTED_BUILDER_PASSPHRASE = 'myboon-server-injected'
const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/

function requestIdFrom(value: string | undefined): string {
  return value && REQUEST_ID_PATTERN.test(value) ? value : randomUUID()
}

/** Strip queries and dynamic identifiers before writing a path to logs. */
export function normalizedObservedPath(path: string): string {
  const pathname = path.split('?')[0] || '/'
  return pathname
    .replace(/0x[0-9a-fA-F]{16,}/gu, ':hash')
    .replace(/\b[0-9]{12,}\b/gu, ':id')
    .replace(/[A-Za-z0-9_-]{48,}/gu, ':id')
}

export function logPredictRequest(
  level: 'info' | 'warn' | 'error',
  fields: Record<string, string | number | boolean | null | undefined>,
): void {
  const safe = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined))
  console[level](JSON.stringify(safe))
}

function buildBuilderSignature(secret: string, timestamp: string, method: string, path: string, body = ''): string {
  return createHmac('sha256', Buffer.from(secret, 'base64'))
    .update(`${timestamp}${method}${path}${body}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

function headerEntry(headers: Record<string, string>, expectedName: string): [string, string] | undefined {
  return Object.entries(headers).find(([name]) => name.toLowerCase() === expectedName.toLowerCase())
}

/**
 * Materialize the Builder passphrase for the single upstream request it signs.
 * Returns `ok: false` for a forged, stale, or incomplete server-injection marker.
 * Non-marker credentials are left untouched so this stays a transparent proxy
 * for callers using their own Builder account.
 */
export function materializeBuilderPassphrase(
  headers: Record<string, string>,
  method: string,
  path: string,
  body = '',
): { ok: boolean; requestId: string | null } {
  const passphraseEntry = headerEntry(headers, 'POLY_BUILDER_PASSPHRASE')
  if (!passphraseEntry || !passphraseEntry[1].startsWith(SERVER_INJECTED_BUILDER_PASSPHRASE)) {
    return { ok: true, requestId: null }
  }
  const markerParts = passphraseEntry[1].split(':')
  const requestId = markerParts.length === 2 && REQUEST_ID_PATTERN.test(markerParts[1] ?? '')
    ? markerParts[1]!
    : null
  if (!requestId) return { ok: false, requestId: null }

  const builderKey = process.env.POLYMARKET_BUILDER_API_KEY
  const builderSecret = process.env.POLYMARKET_BUILDER_SECRET
  const builderPassphrase = process.env.POLYMARKET_BUILDER_PASSPHRASE
  const apiKey = headerEntry(headers, 'POLY_BUILDER_API_KEY')?.[1]
  const signature = headerEntry(headers, 'POLY_BUILDER_SIGNATURE')?.[1]
  const timestamp = headerEntry(headers, 'POLY_BUILDER_TIMESTAMP')?.[1]
  if (!builderKey || !builderSecret || !builderPassphrase || apiKey !== builderKey || !signature || !timestamp) {
    return { ok: false, requestId }
  }

  const timestampSeconds = Number(timestamp)
  if (!Number.isInteger(timestampSeconds) || Math.abs(Date.now() / 1000 - timestampSeconds) > 5 * 60) {
    return { ok: false, requestId }
  }

  const expected = Buffer.from(buildBuilderSignature(builderSecret, timestamp, method, path, body))
  const actual = Buffer.from(signature)
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return { ok: false, requestId }
  }

  headers[passphraseEntry[0]] = builderPassphrase
  return { ok: true, requestId }
}

function isAllowedBuilderRequest(method: string, path: string): boolean {
  const upper = method.toUpperCase()
  // Builder requests can only be sent to the two fixed upstream hosts in the
  // proxies. Permit well-formed reads so an SDK release cannot break account
  // restoration merely by adding a harmless query endpoint; state-changing
  // operations remain explicitly allowlisted.
  if (upper === 'GET') return path.startsWith('/') && !path.startsWith('//') && !/[\r\n]/u.test(path)
  return ALLOWED_BUILDER_WRITES.some((rule) => rule.method === upper && rule.path.test(path))
}

/**
 * Per-address and per-IP signing budgets.
 *
 * General authorization permits SDK polling and reconciliation. Relayer
 * `/submit` calls have a separate, much tighter budget because those consume
 * Builder-sponsored transaction capacity.
 *
 * These in-memory counters are a cost guard, not a security boundary, and
 * reset on redeploy.
 */
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000
const ADDRESS_RATE_LIMIT_MAX = 500
const IP_RATE_LIMIT_MAX = 2_000
const SUBMIT_ADDRESS_RATE_LIMIT_MAX = 20
const SUBMIT_IP_RATE_LIMIT_MAX = 100
const addressSigningHistory = new Map<string, number[]>()
const ipSigningHistory = new Map<string, number[]>()
const addressSubmissionHistory = new Map<string, number[]>()
const ipSubmissionHistory = new Map<string, number[]>()

function withinRateLimit(history: Map<string, number[]>, identity: string, maximum: number): boolean {
  const now = Date.now()
  const key = identity.toLowerCase()
  const recent = (history.get(key) ?? []).filter((at) => now - at < RATE_LIMIT_WINDOW_MS)
  if (recent.length >= maximum) {
    history.set(key, recent)
    return false
  }
  recent.push(now)
  history.set(key, recent)
  return true
}

function requestIp(headers: Headers): string {
  return headers.get('cf-connecting-ip')
    ?? headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? headers.get('x-real-ip')
    ?? 'unknown'
}

// Drop addresses whose window has fully aged out, so a long-running process
// does not retain an entry per wallet that ever called this route.
setInterval(() => {
  const now = Date.now()
  for (const history of [
    addressSigningHistory,
    ipSigningHistory,
    addressSubmissionHistory,
    ipSubmissionHistory,
  ]) {
    for (const [identity, timestamps] of history) {
      const recent = timestamps.filter((at) => now - at < RATE_LIMIT_WINDOW_MS)
      if (recent.length === 0) history.delete(identity)
      else history.set(identity, recent)
    }
  }
}, RATE_LIMIT_WINDOW_MS).unref?.()

export function registerBuilderSignRoutes(routes: Hono) {
  const builderKey = process.env.POLYMARKET_BUILDER_API_KEY
  const builderSecret = process.env.POLYMARKET_BUILDER_SECRET
  const builderPassphrase = process.env.POLYMARKET_BUILDER_PASSPHRASE

  routes.post('/builder/sign', async (c) => {
    const startedAt = Date.now()
    const requestId = requestIdFrom(c.req.header('X-Predict-Request-ID'))
    c.header('X-Predict-Request-ID', requestId)
    if (!builderKey || !builderSecret || !builderPassphrase) {
      logPredictRequest('error', {
        event: 'builder-sign', requestId, decision: 'refused', status: 500,
        durationMs: Date.now() - startedAt, errorCategory: 'missing_builder_configuration',
      })
      return c.json({ error: 'Builder not configured — set POLYMARKET_BUILDER_* env vars' }, 500)
    }

    // Proof of wallet control, in headers — the SDK owns the JSON body.
    const proofAddress = c.req.header('X-Predict-Address')
    const proofTimestamp = Number(c.req.header('X-Predict-Timestamp'))
    const proofSignature = c.req.header('X-Predict-Signature')
    if (!proofAddress || !proofSignature || !Number.isFinite(proofTimestamp)) {
      logPredictRequest('warn', {
        event: 'builder-sign', requestId, decision: 'refused', status: 401,
        signerDecision: 'missing_proof', durationMs: Date.now() - startedAt,
        errorCategory: 'missing_predict_proof',
      })
      return c.json({ error: 'Missing Predict wallet proof' }, 401)
    }
    if (!verifyPredictAuthProof(proofAddress, proofTimestamp, proofSignature)) {
      logPredictRequest('warn', {
        event: 'builder-sign', requestId, signer: proofAddress, decision: 'refused', status: 401,
        signerDecision: 'invalid_proof', durationMs: Date.now() - startedAt,
        errorCategory: 'invalid_predict_proof',
      })
      return c.json({ error: 'Invalid Predict wallet proof' }, 401)
    }

    let body: { method?: unknown; path?: unknown; body?: unknown }
    try {
      body = await c.req.json()
    } catch {
      logPredictRequest('warn', {
        event: 'builder-sign', requestId, signer: proofAddress, decision: 'refused', status: 400,
        signerDecision: 'verified', durationMs: Date.now() - startedAt, errorCategory: 'bad_json',
      })
      return c.json({ error: 'Bad request' }, 400)
    }

    const { method, path } = body
    if (typeof method !== 'string' || !method || typeof path !== 'string' || !path) {
      logPredictRequest('warn', {
        event: 'builder-sign', requestId, signer: proofAddress, decision: 'refused', status: 400,
        signerDecision: 'verified', durationMs: Date.now() - startedAt,
        errorCategory: 'missing_method_or_path',
      })
      return c.json({ error: 'Missing method or path' }, 400)
    }
    // The SDK sends `body` as a pre-serialized string or omits it. Anything
    // else would interpolate as "[object Object]" into the signed message,
    // producing a signature over text that is not what gets sent upstream.
    if (body.body !== undefined && typeof body.body !== 'string') {
      logPredictRequest('warn', {
        event: 'builder-sign', requestId, method: method.toUpperCase(), path: normalizedObservedPath(path),
        signer: proofAddress, decision: 'refused', status: 400, signerDecision: 'verified',
        durationMs: Date.now() - startedAt, errorCategory: 'invalid_body',
      })
      return c.json({ error: 'Invalid body' }, 400)
    }

    if (!isAllowedBuilderRequest(method, path)) {
      logPredictRequest('warn', {
        event: 'builder-sign', requestId, method: method.toUpperCase(), path: normalizedObservedPath(path),
        signer: proofAddress, decision: 'refused', status: 403,
        signerDecision: 'verified', durationMs: Date.now() - startedAt, errorCategory: 'policy',
      })
      return c.json({ error: `Builder signing not permitted for ${method} ${path}` }, 403)
    }

    const ip = requestIp(c.req.raw.headers)
    const signerWithinLimit = withinRateLimit(addressSigningHistory, proofAddress, ADDRESS_RATE_LIMIT_MAX)
    const ipWithinLimit = withinRateLimit(ipSigningHistory, ip, IP_RATE_LIMIT_MAX)
    if (!signerWithinLimit || !ipWithinLimit) {
      logPredictRequest('warn', {
        event: 'builder-sign', requestId, method: method.toUpperCase(), path: normalizedObservedPath(path),
        signer: proofAddress, decision: 'refused', status: 429,
        signerDecision: signerWithinLimit ? 'within_limit' : 'rate_limited',
        ipDecision: ipWithinLimit ? 'within_limit' : 'rate_limited',
        durationMs: Date.now() - startedAt, errorCategory: 'rate_limit',
      })
      return c.json({ error: 'Too many Builder signing requests. Try again later.' }, 429)
    }

    if (method.toUpperCase() === 'POST' && path === '/submit') {
      let submission: Record<string, unknown>
      try {
        submission = body.body ? JSON.parse(body.body) as Record<string, unknown> : {}
      } catch {
        logPredictRequest('warn', {
          event: 'builder-sign', requestId, method: 'POST', path: '/submit', signer: proofAddress,
          decision: 'refused', status: 400, signerDecision: 'verified', ipDecision: 'within_limit',
          durationMs: Date.now() - startedAt, errorCategory: 'invalid_submission_body',
        })
        return c.json({ error: 'Invalid Relayer submission body' }, 400)
      }
      if (
        typeof submission.from !== 'string'
        || !/^0x[0-9a-fA-F]{40}$/u.test(submission.from)
        || submission.from.toLowerCase() !== proofAddress.toLowerCase()
      ) {
        logPredictRequest('warn', {
          event: 'builder-sign', requestId, method: 'POST', path: '/submit', signer: proofAddress,
          decision: 'refused', status: 403, durationMs: Date.now() - startedAt,
          signerDecision: 'submission_mismatch', ipDecision: 'within_limit',
          errorCategory: 'signer_mismatch',
        })
        return c.json({ error: 'Relayer signer does not match Predict proof' }, 403)
      }
      const signerSubmitWithinLimit = withinRateLimit(
        addressSubmissionHistory,
        proofAddress,
        SUBMIT_ADDRESS_RATE_LIMIT_MAX,
      )
      const ipSubmitWithinLimit = withinRateLimit(ipSubmissionHistory, ip, SUBMIT_IP_RATE_LIMIT_MAX)
      if (!signerSubmitWithinLimit || !ipSubmitWithinLimit) {
        logPredictRequest('warn', {
          event: 'builder-sign', requestId, method: 'POST', path: '/submit', signer: proofAddress,
          decision: 'refused', status: 429, durationMs: Date.now() - startedAt,
          signerDecision: signerSubmitWithinLimit ? 'within_limit' : 'rate_limited',
          ipDecision: ipSubmitWithinLimit ? 'within_limit' : 'rate_limited',
          errorCategory: 'rate_limit',
        })
        return c.json({ error: 'Too many Relayer submissions. Try again later.' }, 429)
      }
    }

    const timestamp = Math.floor(Date.now() / 1000)
    const signature = buildBuilderSignature(builderSecret, `${timestamp}`, method, path, body.body ?? '')

    const response = c.json({
      POLY_BUILDER_API_KEY: builderKey,
      POLY_BUILDER_PASSPHRASE: `${SERVER_INJECTED_BUILDER_PASSPHRASE}:${requestId}`,
      POLY_BUILDER_SIGNATURE: signature,
      POLY_BUILDER_TIMESTAMP: `${timestamp}`,
    })
    logPredictRequest('info', {
      event: 'builder-sign', requestId, method: method.toUpperCase(), path: normalizedObservedPath(path),
      signer: proofAddress, decision: 'allowed', status: 200, signerDecision: 'verified_within_limit',
      ipDecision: 'within_limit', durationMs: Date.now() - startedAt,
    })
    return response
  })
}
