import type { Hono } from 'hono'
import { createHmac } from 'node:crypto'

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
 * HMAC-SHA256, output re-encoded base64url — identical to the old SDK's
 * `@polymarket/builder-signing-sdk` signer, which this app already trusted
 * for the same purpose.
 */
export function registerBuilderSignRoutes(routes: Hono) {
  const builderKey = process.env.POLYMARKET_BUILDER_API_KEY
  const builderSecret = process.env.POLYMARKET_BUILDER_SECRET
  const builderPassphrase = process.env.POLYMARKET_BUILDER_PASSPHRASE

  routes.post('/builder/sign', async (c) => {
    if (!builderKey || !builderSecret || !builderPassphrase) {
      return c.json({ error: 'Builder not configured — set POLYMARKET_BUILDER_* env vars' }, 500)
    }

    let body: { method?: string; path?: string; body?: string }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Bad request' }, 400)
    }
    const { method, path } = body
    if (!method || !path) {
      return c.json({ error: 'Missing method or path' }, 400)
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
