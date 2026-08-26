/**
 * Smoke test — run on VPS to verify the API is working.
 * Usage: API_BASE=http://localhost:3000 npx tsx src/smoke-test.ts
 */

const BASE = process.env.API_BASE ?? 'http://localhost:3000'

type Result = { endpoint: string; status: number | 'ERR'; ok: boolean; note?: string }

async function check(label: string, path: string, expect?: (body: unknown) => string | null): Promise<Result> {
  const url = `${BASE}${path}`
  try {
    const res = await fetch(url)
    const body = await res.json().catch(() => null)
    let note: string | undefined
    if (expect) note = expect(body) ?? undefined
    const ok = res.ok && !note
    console.log(`${ok ? '✓' : '✗'} [${res.status}] ${label}${note ? ` — ${note}` : ''}`)
    return { endpoint: path, status: res.status, ok, note }
  } catch (err) {
    console.log(`✗ [ERR] ${label} — ${err}`)
    return { endpoint: path, status: 'ERR', ok: false, note: String(err) }
  }
}

async function run() {
  console.log(`\nSmoke test → ${BASE}\n`)

  const results: Result[] = []

  // Health
  results.push(await check('GET /health', '/health', (b: unknown) => {
    const body = b as Record<string, unknown>
    return body?.status === 'ok' ? null : `expected {status:'ok'}, got ${JSON.stringify(b)}`
  }))

  // Feed
  results.push(await check('GET /narratives', '/narratives', (b) => {
    if (!Array.isArray(b)) return `expected array, got ${typeof b}`
    return null
  }))

  // Polymarket — curated markets list
  results.push(await check('GET /polymarket/markets', '/polymarket/markets', (b) => {
    if (!Array.isArray(b)) return `expected array, got ${typeof b}`
    if (b.length === 0) return 'warning: empty array (markets may be inactive or geo-blocked upstream)'
    return null
  }))

  // Polymarket — single curated market
  results.push(await check(
    'GET /polymarket/markets/will-the-iranian-regime-fall-by-march-31',
    '/polymarket/markets/will-the-iranian-regime-fall-by-march-31',
    (b) => {
      if (!b || typeof b !== 'object') return `expected market object, got ${typeof b}`
      return null
    }
  ))

  // Polymarket — sports list
  results.push(await check('GET /polymarket/sports/epl', '/polymarket/sports/epl', (b) => {
    if (!Array.isArray(b)) return `expected array, got ${typeof b}`
    return null
  }))

  // Polymarket — non-curated slug should 404
  results.push(await check('GET /polymarket/markets/random-non-curated-slug (expect 404)', '/polymarket/markets/random-non-curated-slug', (b) => {
    const body = b as Record<string, unknown>
    return body?.error === 'Not found' ? null : `expected 404 Not found, got ${JSON.stringify(b)}`
  }))

  // Polymarket — price for a known token (use a real Polymarket token ID if available)
  // Using a placeholder — will return null prices if token doesn't exist, but endpoint should still return 200
  results.push(await check('GET /polymarket/price/:tokenId (endpoint check)', '/polymarket/price/1', (b) => {
    const body = b as Record<string, unknown>
    if (!('tokenId' in body) || !('buy' in body) || !('sell' in body)) {
      return `expected {tokenId, buy, sell}, got ${JSON.stringify(b)}`
    }
    return null
  }))

  const passed = results.filter(r => r.ok).length
  const failed = results.filter(r => !r.ok).length

  console.log(`\n${passed}/${results.length} passed${failed > 0 ? `, ${failed} failed` : ''}`)

  if (failed > 0) process.exit(1)
}

run().catch(err => {
  console.error('Smoke test crashed:', err)
  process.exit(1)
})
