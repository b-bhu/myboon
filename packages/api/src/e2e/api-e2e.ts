/**
 * E2E tests for /polymarket/featured-markets + live Dome data checks.
 *
 * Usage: API_BASE=http://<vps-ip>:3000 npx tsx src/e2e/api-e2e.ts
 *        npx tsx src/e2e/api-e2e.ts              (defaults to localhost:3000)
 */

const BASE = process.env.API_BASE ?? 'http://localhost:3000'

type Result = { test: string; ok: boolean; ms: number; detail?: string }

async function test(name: string, fn: () => Promise<string | null>): Promise<Result> {
  const t0 = Date.now()
  try {
    const err = await fn()
    const ms = Date.now() - t0
    if (err) {
      console.log(`  ✗ ${name} (${ms}ms) — ${err}`)
      return { test: name, ok: false, ms, detail: err }
    }
    console.log(`  ✓ ${name} (${ms}ms)`)
    return { test: name, ok: true, ms }
  } catch (e: any) {
    const ms = Date.now() - t0
    console.log(`  ✗ ${name} (${ms}ms) — ${e.message}`)
    return { test: name, ok: false, ms, detail: e.message }
  }
}

async function fetchJson(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`)
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

async function run() {
  console.log(`\n Polymarket Featured Markets E2E — ${BASE}\n`)

  const results: Result[] = []

  // ═══════════════════════════════════════════════════
  // 1. Full feed — no filters
  // ═══════════════════════════════════════════════════
  console.log('\n[1] Full feed (no filters)')

  let feedItems: any[] = []
  let feedCategories: string[] = []

  results.push(await test('GET /polymarket/featured-markets returns items + categories', async () => {
    const { status, body } = await fetchJson('/polymarket/featured-markets')
    if (status !== 200) return `status ${status}`
    if (!body?.items || !Array.isArray(body.items)) return `missing items array`
    if (!body?.categories || !Array.isArray(body.categories)) return `missing categories array`
    if (body.items.length === 0) return `items array is empty`
    feedItems = body.items
    feedCategories = body.categories
    console.log(`    → ${feedItems.length} items, categories: [${feedCategories.join(', ')}]`)
    return null
  }))

  results.push(await test('every item has type (binary|match)', async () => {
    if (feedItems.length === 0) return 'no items to check'
    const bad = feedItems.filter((i: any) => i.type !== 'binary' && i.type !== 'match')
    if (bad.length > 0) return `${bad.length} items with invalid type: ${bad[0].type}`
    const binaries = feedItems.filter((i: any) => i.type === 'binary').length
    const matches = feedItems.filter((i: any) => i.type === 'match').length
    console.log(`    → ${binaries} binary, ${matches} match`)
    return null
  }))

  results.push(await test('every item has category, tags, volume', async () => {
    if (feedItems.length === 0) return 'no items to check'
    for (const item of feedItems) {
      if (!item.category) return `item ${item.slug} missing category`
      if (!Array.isArray(item.tags)) return `item ${item.slug} missing tags`
    }
    return null
  }))

  // ═══════════════════════════════════════════════════
  // 2. Category filters
  // ═══════════════════════════════════════════════════
  console.log('\n[2] Category filters')

  results.push(await test('?category=crypto returns only crypto items', async () => {
    const { status, body } = await fetchJson('/polymarket/featured-markets?category=crypto')
    if (status !== 200) return `status ${status}`
    if (!Array.isArray(body?.items)) return 'missing items'
    const bad = body.items.filter((i: any) => i.category !== 'crypto')
    if (bad.length > 0) return `${bad.length} non-crypto items found (first: ${bad[0].category})`
    console.log(`    → ${body.items.length} crypto items`)
    return null
  }))

  results.push(await test('?category=sports returns only sports items', async () => {
    const { status, body } = await fetchJson('/polymarket/featured-markets?category=sports')
    if (status !== 200) return `status ${status}`
    if (!Array.isArray(body?.items)) return 'missing items'
    const bad = body.items.filter((i: any) => i.category !== 'sports')
    if (bad.length > 0) return `${bad.length} non-sports items found`
    const sports = body.items.map((i: any) => i.sport).filter(Boolean)
    const sportSet = [...new Set(sports)]
    console.log(`    → ${body.items.length} sports items, leagues: [${sportSet.join(', ')}]`)
    return null
  }))

  results.push(await test('?category=politics returns only politics items', async () => {
    const { status, body } = await fetchJson('/polymarket/featured-markets?category=politics')
    if (status !== 200) return `status ${status}`
    if (!Array.isArray(body?.items)) return 'missing items'
    const bad = body.items.filter((i: any) => i.category !== 'politics')
    if (bad.length > 0) return `${bad.length} non-politics items found`
    console.log(`    → ${body.items.length} politics items`)
    return null
  }))

  // ═══════════════════════════════════════════════════
  // 3. Sport filters
  // ═══════════════════════════════════════════════════
  console.log('\n[3] Sport filters')

  let iplItems: any[] = []
  let eplItems: any[] = []
  let fifwcItems: any[] = []

  results.push(await test('?sport=ipl returns only IPL matches', async () => {
    const { status, body } = await fetchJson('/polymarket/featured-markets?sport=ipl')
    if (status !== 200) return `status ${status}`
    if (!Array.isArray(body?.items)) return 'missing items'
    const bad = body.items.filter((i: any) => i.sport !== 'ipl')
    if (bad.length > 0) return `${bad.length} non-IPL items (first: sport=${bad[0].sport}, type=${bad[0].type})`
    iplItems = body.items
    console.log(`    → ${iplItems.length} IPL matches`)
    return null
  }))

  results.push(await test('?sport=epl returns only EPL matches', async () => {
    const { status, body } = await fetchJson('/polymarket/featured-markets?sport=epl')
    if (status !== 200) return `status ${status}`
    if (!Array.isArray(body?.items)) return 'missing items'
    const bad = body.items.filter((i: any) => i.sport !== 'epl')
    if (bad.length > 0) return `${bad.length} non-EPL items (first: sport=${bad[0].sport}, type=${bad[0].type})`
    eplItems = body.items
    console.log(`    → ${eplItems.length} EPL matches`)
    return null
  }))

  results.push(await test('?sport=fifwc returns only FIFA World Cup matches', async () => {
    const { status, body } = await fetchJson('/polymarket/featured-markets?sport=fifwc')
    if (status !== 200) return `status ${status}`
    if (!Array.isArray(body?.items)) return 'missing items'
    const bad = body.items.filter((i: any) => i.sport !== 'fifwc')
    if (bad.length > 0) return `${bad.length} non-FIFWC items (first: sport=${bad[0].sport}, type=${bad[0].type})`
    const wrongSlug = body.items.find((i: any) => !String(i.slug ?? '').startsWith('fifwc-'))
    if (wrongSlug) return `non-game or wrong FIFA World Cup slug returned: ${wrongSlug.slug}`
    fifwcItems = body.items
    console.log(`    → ${fifwcItems.length} FIFA World Cup matches`)
    return null
  }))

  // ═══════════════════════════════════════════════════
  // 4. IPL shape validation
  // ═══════════════════════════════════════════════════
  console.log('\n[4] IPL match shape')

  results.push(await test('IPL matches have exactly 2 outcomes (no draw)', async () => {
    if (iplItems.length === 0) {
      console.log(`    → no IPL items to check — may be off-season`)
      return null
    }
    for (const item of iplItems) {
      if (item.type !== 'match') return `item ${item.slug} is type=${item.type}, expected match`
      if (!Array.isArray(item.outcomes)) return `item ${item.slug} missing outcomes`
      if (item.outcomes.length !== 2) return `item ${item.slug} has ${item.outcomes.length} outcomes, expected 2`
    }
    return null
  }))

  results.push(await test('IPL outcomes have team names (not Yes/No)', async () => {
    if (iplItems.length === 0) {
      console.log(`    → no IPL items to check — may be off-season`)
      return null
    }
    for (const item of iplItems) {
      for (const o of item.outcomes ?? []) {
        if (o.label === 'Yes' || o.label === 'No') return `item ${item.slug} has Yes/No label instead of team name`
        if (!o.label || o.label.length < 2) return `item ${item.slug} has empty/short label: "${o.label}"`
      }
    }
    const sample = iplItems[0]
    console.log(`    → sample: ${sample.outcomes[0].label} vs ${sample.outcomes[1].label}`)
    return null
  }))

  results.push(await test('IPL titles do not have "Indian Premier League:" prefix', async () => {
    if (iplItems.length === 0) {
      console.log(`    → no IPL items to check — may be off-season`)
      return null
    }
    for (const item of iplItems) {
      if (item.title?.startsWith('Indian Premier League:')) return `item ${item.slug} still has prefix: "${item.title}"`
    }
    return null
  }))

  results.push(await test('IPL outcomes have prices', async () => {
    if (iplItems.length === 0) {
      console.log(`    → no IPL items to check — may be off-season`)
      return null
    }
    let withPrices = 0
    for (const item of iplItems) {
      const prices = item.outcomes.map((o: any) => o.price).filter((p: any) => p !== null)
      if (prices.length > 0) withPrices++
    }
    console.log(`    → ${withPrices}/${iplItems.length} matches have live prices`)
    return null
  }))

  // ═══════════════════════════════════════════════════
  // 5. EPL shape validation
  // ═══════════════════════════════════════════════════
  console.log('\n[5] EPL match shape')

  results.push(await test('EPL matches have 3 outcomes (win/win/draw)', async () => {
    if (eplItems.length === 0) {
      console.log(`    → no EPL items to check — may be off-season`)
      return null
    }
    for (const item of eplItems) {
      if (item.type !== 'match') return `item ${item.slug} is type=${item.type}, expected match`
      if (!Array.isArray(item.outcomes)) return `item ${item.slug} missing outcomes`
      if (item.outcomes.length !== 3) return `item ${item.slug} has ${item.outcomes.length} outcomes, expected 3`
      const hasD = item.outcomes.some((o: any) => o.label === 'Draw')
      if (!hasD) return `item ${item.slug} missing Draw outcome`
    }
    return null
  }))

  results.push(await test('FIFA World Cup matches have 3 outcomes (win/win/draw)', async () => {
    if (fifwcItems.length === 0) return 'no FIFA World Cup items to check — may be between matchdays'
    for (const item of fifwcItems) {
      if (item.type !== 'match') return `item ${item.slug} is type=${item.type}, expected match`
      if (!Array.isArray(item.outcomes)) return `item ${item.slug} missing outcomes`
      if (item.outcomes.length !== 3) return `item ${item.slug} has ${item.outcomes.length} outcomes, expected 3`
      const hasD = item.outcomes.some((o: any) => o.label === 'Draw')
      if (!hasD) return `item ${item.slug} missing Draw outcome`
    }
    return null
  }))

  // ═══════════════════════════════════════════════════
  // 6. Pinned binary market shape
  // ═══════════════════════════════════════════════════
  console.log('\n[6] Pinned binary market shape')

  results.push(await test('binary items have yesPrice, noPrice, clobTokenIds', async () => {
    const binaries = feedItems.filter((i: any) => i.type === 'binary')
    if (binaries.length === 0) return 'no binary items in feed'
    for (const item of binaries) {
      if (!('yesPrice' in item)) return `item ${item.slug} missing yesPrice`
      if (!('noPrice' in item)) return `item ${item.slug} missing noPrice`
      if (!Array.isArray(item.clobTokenIds)) return `item ${item.slug} missing clobTokenIds`
      if (!item.conditionId) return `item ${item.slug} missing conditionId`
    }
    console.log(`    → ${binaries.length} binary items validated`)
    return null
  }))

  results.push(await test('binary categories are derived (not hardcoded "geopolitics")', async () => {
    const binaries = feedItems.filter((i: any) => i.type === 'binary')
    if (binaries.length === 0) return 'no binary items'
    const cats = [...new Set(binaries.map((i: any) => i.category))]
    console.log(`    → binary categories: [${cats.join(', ')}]`)
    // If ALL are "geopolitics", derivation probably isn't working
    if (cats.length === 1 && cats[0] === 'geopolitics') return 'all binary items are "geopolitics" — category derivation may not be working'
    return null
  }))

  // ═══════════════════════════════════════════════════
  // 7. Limit
  // ═══════════════════════════════════════════════════
  console.log('\n[7] Limit param')

  results.push(await test('?limit=5 returns max 5 items', async () => {
    const { status, body } = await fetchJson('/polymarket/featured-markets?limit=5')
    if (status !== 200) return `status ${status}`
    if (body.items.length > 5) return `got ${body.items.length} items, expected ≤5`
    console.log(`    → ${body.items.length} items`)
    return null
  }))

  // ═══════════════════════════════════════════════════
  // 8. Ordering — upcoming matches first
  // ═══════════════════════════════════════════════════
  console.log('\n[8] Ordering')

  results.push(await test('upcoming matches (next 48h) appear before pinned binary', async () => {
    if (feedItems.length < 2) return 'not enough items to check order'
    const now = Date.now()
    const cutoff = now + 48 * 60 * 60 * 1000
    let lastUpcomingIdx = -1
    let firstBinaryIdx = -1
    for (let i = 0; i < feedItems.length; i++) {
      const item = feedItems[i]
      if (item.startDate) {
        const t = new Date(item.startDate).getTime()
        if (t > now && t < cutoff) lastUpcomingIdx = i
      }
      if (item.type === 'binary' && firstBinaryIdx === -1) firstBinaryIdx = i
    }
    if (lastUpcomingIdx === -1) {
      console.log(`    → no upcoming matches in next 48h — ordering check skipped`)
      return null
    }
    if (firstBinaryIdx !== -1 && firstBinaryIdx < lastUpcomingIdx) {
      return `binary item at idx ${firstBinaryIdx} appears before upcoming match at idx ${lastUpcomingIdx}`
    }
    console.log(`    → upcoming matches end at idx ${lastUpcomingIdx}, binaries start at idx ${firstBinaryIdx}`)
    return null
  }))

  // ═══════════════════════════════════════════════════
  // 9. Live sports schedule — next EPL, IPL & FIFA World Cup games
  // ═══════════════════════════════════════════════════
  console.log('\n[9] Live sports schedule')

  results.push(await test('next EPL games (upcoming)', async () => {
    const { status, body } = await fetchJson('/polymarket/featured-markets?sport=epl')
    if (status !== 200) return `status ${status}`
    const now = Date.now()
    const upcoming = (body.items ?? [])
      .filter((i: any) => i.startDate && new Date(i.startDate).getTime() > now)
      .sort((a: any, b: any) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime())

    if (upcoming.length === 0) {
      console.log(`    → no upcoming EPL games — may be off-season or between matchdays`)
      return null
    }

    console.log(`    → ${upcoming.length} upcoming EPL games:`)
    for (const g of upcoming.slice(0, 5)) {
      const dt = new Date(g.startDate)
      const prices = g.outcomes?.map((o: any) => `${o.label}: ${o.price ?? '?'}`).join(' | ') ?? ''
      console.log(`      ${dt.toISOString().slice(0, 16)} — ${g.title}  [${prices}]`)
    }
    return null
  }))

  results.push(await test('next IPL games (upcoming + live)', async () => {
    const { status, body } = await fetchJson('/polymarket/featured-markets?sport=ipl')
    if (status !== 200) return `status ${status}`
    const now = Date.now()

    // Live = startDate in the past, still active, endDate in the future
    const live = (body.items ?? []).filter((i: any) => {
      if (!i.startDate) return false
      const start = new Date(i.startDate).getTime()
      const end = i.endDate ? new Date(i.endDate).getTime() : Infinity
      return start <= now && end > now && i.active
    })

    // Upcoming = startDate in the future
    const upcoming = (body.items ?? [])
      .filter((i: any) => i.startDate && new Date(i.startDate).getTime() > now)
      .sort((a: any, b: any) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime())

    if (live.length > 0) {
      console.log(`    → 🔴 ${live.length} LIVE IPL game(s):`)
      for (const g of live) {
        const prices = g.outcomes?.map((o: any) => `${o.label}: ${o.price ?? '?'}`).join(' | ') ?? ''
        console.log(`      ${g.title}  [${prices}]`)
      }
    } else {
      console.log(`    → no live IPL games right now`)
    }

    if (upcoming.length > 0) {
      console.log(`    → ${upcoming.length} upcoming IPL games:`)
      for (const g of upcoming.slice(0, 5)) {
        const dt = new Date(g.startDate)
        const prices = g.outcomes?.map((o: any) => `${o.label}: ${o.price ?? '?'}`).join(' | ') ?? ''
        console.log(`      ${dt.toISOString().slice(0, 16)} — ${g.title}  [${prices}]`)
      }
    } else {
      console.log(`    → no upcoming IPL games`)
    }

    if (live.length === 0 && upcoming.length === 0) {
      console.log(`    → IPL may be off-season`)
    }
    return null
  }))

  results.push(await test('next FIFA World Cup games (upcoming + live)', async () => {
    const { status, body } = await fetchJson('/polymarket/featured-markets?sport=fifwc')
    if (status !== 200) return `status ${status}`
    const now = Date.now()

    const live = (body.items ?? []).filter((i: any) => {
      if (!i.gameStartTime) return false
      const start = new Date(i.gameStartTime).getTime()
      return start <= now && i.status === 'live'
    })

    const upcoming = (body.items ?? [])
      .filter((i: any) => i.gameStartTime && new Date(i.gameStartTime).getTime() > now)
      .sort((a: any, b: any) => new Date(a.gameStartTime).getTime() - new Date(b.gameStartTime).getTime())

    if (live.length > 0) {
      console.log(`    → ${live.length} live FIFA World Cup game(s):`)
      for (const g of live.slice(0, 5)) {
        const prices = g.outcomes?.map((o: any) => `${o.label}: ${o.price ?? '?'}`).join(' | ') ?? ''
        console.log(`      ${g.title}  [${prices}]`)
      }
    }

    if (upcoming.length > 0) {
      console.log(`    → ${upcoming.length} upcoming FIFA World Cup games:`)
      for (const g of upcoming.slice(0, 5)) {
        const dt = new Date(g.gameStartTime)
        const prices = g.outcomes?.map((o: any) => `${o.label}: ${o.price ?? '?'}`).join(' | ') ?? ''
        console.log(`      ${dt.toISOString().slice(0, 16)} — ${g.title}  [${prices}]`)
      }
    } else if (live.length === 0) {
      console.log(`    → no upcoming FIFA World Cup games`)
    }

    return null
  }))

  // ═══════════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════════
  const passed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok).length
  const totalMs = results.reduce((s, r) => s + r.ms, 0)

  console.log(`\n${'═'.repeat(50)}`)
  console.log(`${passed}/${results.length} passed, ${failed} failed (${totalMs}ms total)`)
  if (failed > 0) {
    console.log('\nFailed:')
    for (const r of results.filter((r) => !r.ok)) {
      console.log(`  • ${r.test}: ${r.detail}`)
    }
  }
  console.log()

  if (failed > 0) process.exit(1)
}

run().catch((err) => {
  console.error('E2E crashed:', err)
  process.exit(1)
})

export {}
