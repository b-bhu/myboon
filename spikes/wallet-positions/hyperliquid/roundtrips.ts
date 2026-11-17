// Rebuild open-to-close round trips from raw Hyperliquid fills. Our own PnL math; closedPnl only as a cross-check.
// Usage: node --experimental-strip-types roundtrips.ts [dir-with-fills.json-and-funding.json] [out-trips.json]
// Defaults to ./sample (0x718cc7ee2ae2493ebf7d454316df6b61f4e1a868, Nov 6-13 2026).
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2] ?? join(import.meta.dirname, 'sample')
const outPath = process.argv[3]

type Fill = { coin: string; px: string; sz: string; side: 'B' | 'A'; time: number; startPosition: string; dir: string; closedPnl: string; fee: string; feeToken: string }
type Funding = { time: number; delta: { coin: string; usdc: string; type: string } }

type Trip = {
  coin: string; side: 'long' | 'short'; openTime: number; closeTime: number | null
  openedBeforeWindow: boolean; entryQty: number; entryNotional: number; exitQty: number; exitNotional: number
  maxSize: number; basisQty: number; basisNotional: number; fees: number; ourPnl: number; hlClosedPnl: number; funding: number; fills: number
}

const fills: Fill[] = JSON.parse(readFileSync(join(dir, 'fills.json'), 'utf8'))
const funding: Funding[] = JSON.parse(readFileSync(join(dir, 'funding.json'), 'utf8'))
fills.sort((a, b) => a.time - b.time)

const trips: Trip[] = []
const open = new Map<string, Trip & { pos: number }>()
const EPS = 1e-9

for (const f of fills) {
  const px = Number(f.px), sz = Number(f.sz), fee = Number(f.fee)
  const signed = f.side === 'B' ? sz : -sz
  let cur = open.get(f.coin)
  const start = Number(f.startPosition)
  if (!cur && Math.abs(start) > EPS) {
    // Position existed before the window: entry price unknown, seed at this fill's px and flag it.
    cur = { coin: f.coin, side: start > 0 ? 'long' : 'short', openTime: f.time, closeTime: null, openedBeforeWindow: true,
      entryQty: Math.abs(start), entryNotional: Math.abs(start) * px, exitQty: 0, exitNotional: 0, maxSize: Math.abs(start), basisQty: Math.abs(start), basisNotional: Math.abs(start) * px,
      fees: 0, ourPnl: 0, hlClosedPnl: 0, funding: 0, fills: 0, pos: start }
    open.set(f.coin, cur)
  }
  let remaining = signed
  let feeLeft = fee
  while (Math.abs(remaining) > EPS) {
    if (!cur) {
      cur = { coin: f.coin, side: remaining > 0 ? 'long' : 'short', openTime: f.time, closeTime: null, openedBeforeWindow: false,
        entryQty: 0, entryNotional: 0, exitQty: 0, exitNotional: 0, maxSize: 0, basisQty: 0, basisNotional: 0, fees: 0, ourPnl: 0, hlClosedPnl: 0, funding: 0, fills: 0, pos: 0 }
      open.set(f.coin, cur)
    }
    const dirSign = cur.side === 'long' ? 1 : -1
    const adding = Math.sign(remaining) === dirSign || Math.abs(cur.pos) < EPS
    const part = adding ? Math.abs(remaining) : Math.min(Math.abs(remaining), Math.abs(cur.pos))
    const share = part / sz
    const partFee = fee * share
    feeLeft -= partFee
    cur.fees += partFee
    cur.fills += 1
    if (adding) {
      cur.entryQty += part; cur.entryNotional += part * px; cur.basisQty += part; cur.basisNotional += part * px
      cur.pos += dirSign * part
    } else {
      const avgEntry = cur.basisNotional / cur.basisQty
      cur.basisQty -= part; cur.basisNotional -= avgEntry * part
      cur.ourPnl += (px - avgEntry) * part * dirSign
      cur.hlClosedPnl += Number(f.closedPnl) * share
      cur.exitQty += part; cur.exitNotional += part * px
      cur.pos -= dirSign * part
    }
    cur.maxSize = Math.max(cur.maxSize, Math.abs(cur.pos))
    remaining -= Math.sign(remaining) * part
    if (Math.abs(cur.pos) < EPS && cur.exitQty > 0) {
      cur.closeTime = f.time
      const { pos: _p, ...t } = cur
      trips.push(t)
      open.delete(f.coin)
      cur = undefined
    }
  }
}
for (const c of open.values()) { const { pos: _p, ...t } = c; trips.push(t) }

for (const fu of funding) {
  const t = trips.find(t => t.coin === fu.delta.coin && fu.time >= t.openTime && (t.closeTime === null || fu.time <= t.closeTime))
  if (t) t.funding += Number(fu.delta.usdc)
}

trips.sort((a, b) => a.openTime - b.openTime)
const ist = (ms: number) => new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true })
const rows = trips.map(t => {
  const entry = t.entryNotional / t.entryQty
  const exit = t.exitQty ? t.exitNotional / t.exitQty : NaN
  const net = t.ourPnl - t.fees + t.funding
  const hrs = ((t.closeTime ?? Date.now()) - t.openTime) / 3.6e6
  return { coin: t.coin, side: t.side, open: ist(t.openTime), close: t.closeTime ? ist(t.closeTime) : 'STILL OPEN', hours: +hrs.toFixed(1),
    size: +t.maxSize.toFixed(4), notional: +(t.maxSize * entry).toFixed(0), entry: +entry.toPrecision(6), exit: isNaN(exit) ? null : +exit.toPrecision(6),
    gross: +t.ourPnl.toFixed(2), fees: +t.fees.toFixed(2), funding: +t.funding.toFixed(2), net: +net.toFixed(2),
    retPct: +((t.ourPnl / (t.maxSize * entry)) * 100).toFixed(2), hlCheck: +t.hlClosedPnl.toFixed(2), preWindow: t.openedBeforeWindow, fills: t.fills }
})
if (outPath) writeFileSync(outPath, JSON.stringify(rows, null, 2))
console.table(rows.map(({ hlCheck, fills, ...r }) => r))
const closed = rows.filter(r => r.close !== 'STILL OPEN')
const sum = (k: 'gross' | 'fees' | 'funding' | 'net' | 'hlCheck') => closed.reduce((s, r) => s + r[k], 0)
console.log({ trips: rows.length, closed: closed.length, wins: closed.filter(r => r.net > 0).length, losses: closed.filter(r => r.net <= 0).length,
  gross: sum('gross').toFixed(2), fees: sum('fees').toFixed(2), funding: sum('funding').toFixed(2), net: sum('net').toFixed(2), hlClosedPnlCheck: sum('hlCheck').toFixed(2),
  maxDiffVsHl: Math.max(...closed.map(r => Math.abs(r.gross - r.hlCheck))).toFixed(2) })
