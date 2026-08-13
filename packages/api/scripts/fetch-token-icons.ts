/**
 * Download token icons once into packages/api/assets/token-icons/.
 *
 * Why this instead of a nightly job and a database table: a token's logo does
 * not change. BTC's icon will be the same next week. So there is no reason for
 * the API to hold a live dependency on an upstream image host, or for a table
 * to exist purely to remember URLs. Fetch the bytes once, serve them from our
 * own origin, commit them (2.9 MB for ~100 icons).
 *
 * Per asset it takes the best icon available:
 *   1. the Tokens registry's canonical logo (needs TOKENS_API_KEY), which is
 *      the real, curated artwork — used for ~34 of our assets today
 *   2. the venue's own icon from the seed, for everything the registry has
 *      never curated (most crypto mid-caps and every meme coin)
 * Anything neither source has stays absent and renders a letter box, which is
 * the honest outcome — never a guessed logo.
 *
 * Usage:
 *   TOKENS_API_KEY=... pnpm --filter @myboon/api run tokens:icons
 *
 * Re-run it after adding markets to the seed. It skips files already present
 * unless --force is passed.
 */
import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const SEED_URL = new URL('../src/tokens/seed/token-identities.seed.json', import.meta.url)
const DEST_DIR = new URL('../assets/token-icons/', import.meta.url)
const TOKENS_API_BASE = process.env.TOKENS_API_BASE || 'https://api.tokens.xyz/v1'

interface SeedEntry {
  assetId: string
  symbol: string
  iconSourceUrl: string | null
}

const force = process.argv.includes('--force')

function extensionFor(url: string): string {
  if (/\.png(\?|$)/i.test(url)) return 'png'
  if (/\.webp(\?|$)/i.test(url)) return 'webp'
  if (/\.jpe?g(\?|$)/i.test(url)) return 'jpg'
  return 'svg'
}

async function alreadyHave(assetId: string): Promise<boolean> {
  for (const ext of ['svg', 'png', 'webp', 'jpg']) {
    try {
      await access(new URL(`${assetId}.${ext}`, DEST_DIR))
      return true
    } catch {
      // keep looking
    }
  }
  return false
}

/** The registry's canonical logo for one of our seed slugs, if it has one. */
async function canonicalIconUrl(assetId: string, apiKey: string): Promise<string | null> {
  try {
    const res = await fetch(`${TOKENS_API_BASE}/assets/${encodeURIComponent(assetId)}`, {
      headers: { 'x-api-key': apiKey },
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) return null
    const body = await res.json() as { asset?: { imageUrl?: string | null } }
    const url = body.asset?.imageUrl
    return typeof url === 'string' && url.length > 0 ? url : null
  } catch {
    return null
  }
}

async function main(): Promise<void> {
  const apiKey = process.env.TOKENS_API_KEY
  if (!apiKey) {
    console.warn('[tokens:icons] No TOKENS_API_KEY — falling back to venue icons only.')
  }

  await mkdir(DEST_DIR, { recursive: true })
  const seed = JSON.parse(await readFile(SEED_URL, 'utf8')) as SeedEntry[]

  let fromTokens = 0
  let fromVenue = 0
  let skipped = 0
  const missing: string[] = []

  for (const entry of seed) {
    if (!force && await alreadyHave(entry.assetId)) {
      skipped += 1
      continue
    }

    const canonical = apiKey ? await canonicalIconUrl(entry.assetId, apiKey) : null
    const url = canonical ?? entry.iconSourceUrl
    if (!url) {
      missing.push(entry.symbol)
      continue
    }

    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(25_000) })
      if (!res.ok) {
        missing.push(`${entry.symbol} (http ${res.status})`)
        continue
      }
      const bytes = new Uint8Array(await res.arrayBuffer())
      if (bytes.byteLength === 0) {
        missing.push(`${entry.symbol} (empty)`)
        continue
      }
      await writeFile(new URL(`${entry.assetId}.${extensionFor(url)}`, DEST_DIR), bytes)
      if (canonical) fromTokens += 1
      else fromVenue += 1
    } catch (err) {
      missing.push(`${entry.symbol} (${err instanceof Error ? err.message : 'failed'})`)
    }
  }

  console.log(`[tokens:icons] into ${fileURLToPath(DEST_DIR)}`)
  console.log(`[tokens:icons] canonical (Tokens): ${fromTokens}  venue: ${fromVenue}  already present: ${skipped}`)
  if (missing.length > 0) {
    // Not a failure: these render the shared letter box, which is correct.
    console.log(`[tokens:icons] no icon available (${missing.length}): ${missing.join(', ')}`)
  }
}

main().catch((err) => {
  console.error('[tokens:icons] failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
