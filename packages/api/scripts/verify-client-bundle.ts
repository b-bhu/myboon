/** Inspect a dev bundle served by an EXISTING Metro instance without saving it. */
import { config } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { rpcEndpointSecrets } from '../src/rpc/policy.js'

config({ path: fileURLToPath(new URL('../.env', import.meta.url)) })
const metro = (process.argv[2] ?? 'http://localhost:8081').replace(/\/$/, '')

try {
  const manifestResponse = await fetch(metro, {
    headers: { 'expo-platform': 'android', Accept: 'application/expo+json' },
    signal: AbortSignal.timeout(20_000),
  })
  if (!manifestResponse.ok) throw new Error('Manifest unavailable')
  const manifest = await manifestResponse.json() as { launchAsset?: { url?: string } }
  if (!manifest.launchAsset?.url) throw new Error('Bundle URL unavailable')
  const bundleResponse = await fetch(manifest.launchAsset.url, { signal: AbortSignal.timeout(60_000) })
  if (!bundleResponse.ok) throw new Error('Bundle unavailable')
  const bundle = await bundleResponse.text()
  const keys = [
    'JUP_API_KEY', 'JUPITER_API_KEY', 'SOLANA_RPC_URL', 'HELIUS_RPC_URL', 'POLYGON_RPC_URL',
    'SOLANA_WS_RPC_URL', 'SOLANA_DEVNET_RPC_URL', 'SOLANA_DEVNET_WS_RPC_URL',
  ]
  const checks = keys.filter((name) => !!process.env[name]?.trim()).map((name) => {
    const value = process.env[name]!.trim()
    const secrets = name === 'JUP_API_KEY' ? [value] : rpcEndpointSecrets(value)
    // A public, keyless provider URL may also be a literal in an installed SDK.
    // Scan full endpoints only when they actually contain credentials.
    const credentialConfigured = !name.endsWith('_URL') || secrets.length > 1
    return {
      variable: name,
      credentialConfigured,
      credentialPresent: credentialConfigured && secrets.some((secret) => bundle.includes(secret)),
    }
  })
  const passed = checks.length > 0 && checks.every((check) => !check.credentialPresent)
  console.log(JSON.stringify({
    checkedAt: new Date().toISOString(),
    status: passed ? 'pass' : 'fail',
    platform: 'android',
    build: 'development',
    bytes: Buffer.byteLength(bundle),
    checks,
  }, null, 2))
  if (!passed) process.exitCode = 1
} catch {
  // Never print provider credentials, raw bundle contents or thrown URL errors.
  console.log(JSON.stringify({ status: 'unverified', reason: 'Existing Metro manifest or bundle unavailable' }))
  process.exitCode = 1
}
