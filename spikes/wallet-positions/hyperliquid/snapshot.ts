// Read-only Hyperliquid wallet snapshot from the public info API (no key).
// Usage: node --experimental-strip-types snapshot.ts <0xaddress> [--hours 48]
// Prints account value, perp positions (native + every HIP-3 dex), spot balances,
// portfolio PnL (day/week/month/allTime) and a fill summary for the last N hours.

const INFO_URL = 'https://api.hyperliquid.xyz/info'
const FILLS_PAGE_CAP = 2000 // userFillsByTime returns at most 2000 fills per response.

type Leverage = { type: 'cross' | 'isolated'; value: number }
type AssetPosition = {
  position: {
    coin: string; szi: string; entryPx: string | null; positionValue: string; unrealizedPnl: string
    leverage: Leverage; liquidationPx: string | null; marginUsed: string
  }
}
type ClearinghouseState = {
  marginSummary: { accountValue: string; totalNtlPos: string; totalMarginUsed: string }
  withdrawable: string
  assetPositions: AssetPosition[]
}
type SpotState = { balances: { coin: string; total: string; hold: string; entryNtl: string }[] }
type PerpDex = { name: string; fullName?: string } | null
type PortfolioWindow = { accountValueHistory: [number, string][]; pnlHistory: [number, string][]; vlm: string }
type Portfolio = [string, PortfolioWindow][]
type Fill = { coin: string; px: string; sz: string; side: 'B' | 'A'; time: number; dir: string; closedPnl: string; fee: string }

async function info<T>(body: Record<string, unknown>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(INFO_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (res.status === 429 && attempt < 3) { await new Promise(r => setTimeout(r, 2000 * (attempt + 1))); continue }
    if (!res.ok) throw new Error(`${String(body.type)}: HTTP ${res.status} ${await res.text()}`)
    return (await res.json()) as T
  }
}

async function fillsSince(user: string, startTime: number): Promise<Fill[]> {
  const all: Fill[] = []
  let from = startTime
  for (;;) {
    const page = await info<Fill[]>({ type: 'userFillsByTime', user, startTime: from, aggregateByTime: false })
    all.push(...page)
    if (page.length < FILLS_PAGE_CAP) return all
    from = Math.max(...page.map(f => f.time)) + 1 // paginate forward by time
  }
}

const usd = (v: string | number) => {
  const n = Number(v)
  return `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`
}
const ist = (ms: number) => new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) + ' IST'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const user = args.find(a => /^0x[0-9a-fA-F]{40}$/.test(a))
  const hoursAt = args.indexOf('--hours')
  const hours = hoursAt >= 0 ? Number(args[hoursAt + 1]) : 48
  if (!user || !Number.isFinite(hours)) throw new Error('Usage: node --experimental-strip-types snapshot.ts <0xaddress> [--hours 48]')

  const dexes = (await info<PerpDex[]>({ type: 'perpDexs' })).filter((d): d is { name: string } => d !== null).map(d => d.name)
  const [native, spot, portfolio, ...hip3] = await Promise.all([
    info<ClearinghouseState>({ type: 'clearinghouseState', user }),
    info<SpotState>({ type: 'spotClearinghouseState', user }),
    info<Portfolio>({ type: 'portfolio', user }),
    ...dexes.map(dex => info<ClearinghouseState>({ type: 'clearinghouseState', user, dex })),
  ])

  console.log(`Wallet ${user}  (checked ${ist(Date.now())})`)
  console.log(`Account value ${usd(native.marginSummary.accountValue)}, notional ${usd(native.marginSummary.totalNtlPos)}, margin used ${usd(native.marginSummary.totalMarginUsed)}, withdrawable ${usd(native.withdrawable)}`)

  const books: [string, ClearinghouseState][] = [['native', native], ...dexes.map((d, i): [string, ClearinghouseState] => [d, hip3[i] as ClearinghouseState])]
  console.log('\nPerp positions:')
  let count = 0
  for (const [dex, st] of books) {
    if (dex !== 'native' && Number(st.marginSummary.accountValue) !== 0) console.log(`  [${dex}] account value ${usd(st.marginSummary.accountValue)}`)
    for (const { position: p } of st.assetPositions) {
      count += 1
      const sz = Number(p.szi)
      console.log(`  [${dex}] ${p.coin} ${sz > 0 ? 'LONG' : 'SHORT'} ${Math.abs(sz)}  value ${usd(p.positionValue)}  entry ${p.entryPx}  uPnL ${usd(p.unrealizedPnl)}  ${p.leverage.value}x ${p.leverage.type}  liq ${p.liquidationPx ?? 'n/a'}`)
    }
  }
  if (count === 0) console.log('  none')
  console.log(`  (checked native + ${dexes.length} HIP-3 dexes: ${dexes.join(', ')})`)

  console.log('\nSpot balances:')
  const bal = spot.balances.filter(b => Number(b.total) !== 0)
  for (const b of bal) console.log(`  ${b.coin} ${b.total} (hold ${b.hold})`)
  if (bal.length === 0) console.log('  none')

  console.log('\nPortfolio PnL (Hyperliquid figures, perps + spot):')
  for (const [name, w] of portfolio) {
    if (!['day', 'week', 'month', 'allTime'].includes(name)) continue
    const last = w.pnlHistory.at(-1)?.[1] ?? '0'
    console.log(`  ${name.padEnd(8)} PnL ${usd(last)}  volume ${usd(w.vlm)}`)
  }

  const fills = await fillsSince(user, Date.now() - hours * 3.6e6)
  const realized = fills.reduce((s, f) => s + Number(f.closedPnl), 0)
  const fees = fills.reduce((s, f) => s + Number(f.fee), 0)
  const coins = [...new Set(fills.map(f => f.coin))]
  console.log(`\nFills, last ${hours}h: ${fills.length}  coins ${coins.join(', ') || 'none'}  realized (closedPnl) ${usd(realized)}  fees ${usd(fees)}`)
  const lastFill = fills.reduce<Fill | undefined>((a, f) => (!a || f.time > a.time ? f : a), undefined)
  if (lastFill) console.log(`  last fill ${ist(lastFill.time)}: ${lastFill.dir} ${lastFill.sz} ${lastFill.coin} @ ${lastFill.px}`)
}

main().catch((err: unknown) => { console.error(err instanceof Error ? err.message : err); process.exit(1) })
