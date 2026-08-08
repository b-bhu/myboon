import type { Hono } from 'hono'
import { createHmac } from 'node:crypto'
import { verifyPredictSessionProof } from '../sessions.js'

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
 * signs with the secret it already holds (`POLYMARKET_BUILDER_SECRET`, same
 * one `wallet.ts`'s `relayerBuilderConfig` uses for the old SDK), and
 * returns the four `POLY_BUILDER_*` headers. The secret never leaves the
 * server. HMAC scheme matches `@polymarket/client`'s own `buildHmacSignature`
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
 * EOA, and `verifyPredictSessionProof` recovers the address from the
 * signature (see `/clob/auth` in `session.ts`, which gates identically).
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
 * The two `/auth` entries are one CLOB operation, not two. `@polymarket/client`
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
 *
 * Allowlisting means a stolen or replayed proof still cannot direct this app's
 * Builder credential at arbitrary relayer or CLOB operations.
 *
 * If a future SDK version adds an endpoint, it fails closed here with a 403
 * naming the path, rather than silently widening what this key authorizes.
 * Fail-closed is the right default, but note it makes a missing path look like
 * an auth failure from the client — check for `[builder-sign] refused` here
 * before assuming the credentials or the proof are at fault.
 */
const ALLOWED_BUILDER_PATHS: ReadonlyArray<{ method: string; path: RegExp }> = [
  { method: 'GET', path: /^\/deployed(\?.*)?$/ },
  { method: 'POST', path: /^\/submit$/ },
  // Credential acquisition: create first, then derive if one already exists.
  { method: 'POST', path: /^\/auth\/api-key$/ },
  { method: 'GET', path: /^\/auth\/derive-api-key$/ },
]

function isAllowedBuilderRequest(method: string, path: string): boolean {
  const upper = method.toUpperCase()
  return ALLOWED_BUILDER_PATHS.some((rule) => rule.method === upper && rule.path.test(path))
}

/**
 * Per-address signing budget.
 *
 * Bounds what any single wallet can draw from the Builder relayer quota.
 * Account setup needs a handful of signatures (a `/deployed` check plus the
 * deploy and approval submissions), so this is generous for real use and
 * still caps a scripted wallet well below the Unverified tier's 100/day.
 *
 * In-memory and per-process, matching `sessions` in `sessions.ts` — this is
 * a cost guard, not a security boundary, and it resets on redeploy like
 * every other piece of runtime state here.
 */
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000
const RATE_LIMIT_MAX_PER_WINDOW = 20
const signingHistory = new Map<string, number[]>()

function withinRateLimit(address: string): boolean {
  const now = Date.now()
  const key = address.toLowerCase()
  const recent = (signingHistory.get(key) ?? []).filter((at) => now - at < RATE_LIMIT_WINDOW_MS)
  if (recent.length >= RATE_LIMIT_MAX_PER_WINDOW) {
    signingHistory.set(key, recent)
    return false
  }
  recent.push(now)
  signingHistory.set(key, recent)
  return true
}

// Drop addresses whose window has fully aged out, so a long-running process
// does not retain an entry per wallet that ever called this route.
setInterval(() => {
  const now = Date.now()
  for (const [address, timestamps] of signingHistory) {
    const recent = timestamps.filter((at) => now - at < RATE_LIMIT_WINDOW_MS)
    if (recent.length === 0) signingHistory.delete(address)
    else signingHistory.set(address, recent)
  }
}, RATE_LIMIT_WINDOW_MS).unref?.()

export function registerBuilderSignRoutes(routes: Hono) {
  const builderKey = process.env.POLYMARKET_BUILDER_API_KEY
  const builderSecret = process.env.POLYMARKET_BUILDER_SECRET
  const builderPassphrase = process.env.POLYMARKET_BUILDER_PASSPHRASE

  routes.post('/builder/sign', async (c) => {
    if (!builderKey || !builderSecret || !builderPassphrase) {
      return c.json({ error: 'Builder not configured — set POLYMARKET_BUILDER_* env vars' }, 500)
    }

    // Proof of wallet control, in headers — the SDK owns the JSON body.
    const proofAddress = c.req.header('X-Predict-Address')
    const proofTimestamp = Number(c.req.header('X-Predict-Timestamp'))
    const proofSignature = c.req.header('X-Predict-Signature')
    if (!proofAddress || !proofSignature || !Number.isFinite(proofTimestamp)) {
      return c.json({ error: 'Missing Predict session proof' }, 401)
    }
    if (!verifyPredictSessionProof(proofAddress, proofTimestamp, proofSignature)) {
      return c.json({ error: 'Invalid Predict session proof' }, 401)
    }

    let body: { method?: unknown; path?: unknown; body?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Bad request' }, 400)
    }

    const { method, path } = body
    if (typeof method !== 'string' || !method || typeof path !== 'string' || !path) {
      return c.json({ error: 'Missing method or path' }, 400)
    }
    // The SDK sends `body` as a pre-serialized string or omits it. Anything
    // else would interpolate as "[object Object]" into the signed message,
    // producing a signature over text that is not what gets sent upstream.
    if (body.body !== undefined && typeof body.body !== 'string') {
      return c.json({ error: 'Invalid body' }, 400)
    }

    if (!isAllowedBuilderRequest(method, path)) {
      console.warn(`[builder-sign] refused ${method} ${path} for ${proofAddress}`)
      return c.json({ error: `Builder signing not permitted for ${method} ${path}` }, 403)
    }

    if (!withinRateLimit(proofAddress)) {
      console.warn(`[builder-sign] rate limited ${proofAddress}`)
      return c.json({ error: 'Too many Builder signing requests. Try again later.' }, 429)
    }

    const timestamp = Math.floor(Date.now() / 1000)
    const message = `${timestamp}${method}${path}${body.body ?? ''}`
    const signature = createHmac('sha256', Buffer.from(builderSecret, 'base64'))
      .update(message)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')

    return c.json({
      POLY_BUILDER_API_KEY: builderKey,
      POLY_BUILDER_PASSPHRASE: builderPassphrase,
      POLY_BUILDER_SIGNATURE: signature,
      POLY_BUILDER_TIMESTAMP: `${timestamp}`,
    })
  })
}
