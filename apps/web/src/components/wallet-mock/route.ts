// Pure route logic for the Move mock (example data). No I/O.
import { ALL, BY, PX, bal, hasBal, type Endpoint, type Token } from './data'

export type MoveInput = { from: string; to: string; ft: Token; tt: Token; amount: string }
export type Step = { label: string; fee: number; node: number }
export type Plan = { nodes: string[]; steps: Step[]; fee: number }

const chainKey = (name: string) => ALL.find((x) => x.g === 'chain' && x.n === name)?.k

// One chain hop between From and To, or null. Polymarket exits to Solana through its own bridge.
export function hop(f: string, t: string): string | null {
  const F = BY[f], T = BY[t]
  const land = F.g === 'chain' ? F.ch : f === 'polymarket' ? 'Solana' : F.ch
  const hk = chainKey(T.g === 'chain' ? land : T.ch)
  return hk && hk !== f && hk !== t ? hk : null
}

export const amt = (s: string) => { const v = parseFloat(s); return isFinite(v) ? v : 0 }

export function plan(m: MoveInput): Plan {
  const F = BY[m.from], T = BY[m.to], h = hop(m.from, m.to), a = amt(m.amount)
  const swA = m.ft !== 'USDC', swB = m.tt !== 'USDC'
  const nodes = [m.from]
  if (swA) nodes.push('swapA')
  if (h) nodes.push(h)
  if (swB) nodes.push('swapB')
  nodes.push(m.to)
  const L = nodes.length - 1
  const at = (chain: string) => { const i = nodes.indexOf(chainKey(chain) ?? ''); return i > 0 ? i : L }
  const swFee = (t: Token) => +Math.max(0.02, a * PX[t] * 0.003).toFixed(2)
  const st: Step[] = []
  let cur = F.g === 'chain' ? F.n : F.ch
  if (F.g === 'app') st.push({ label: `Withdrawing ${m.ft} from ${F.n}`, fee: m.from === 'polymarket' ? 0.05 : 0.01, node: 0 })
  if (m.from === 'polymarket') { st.push({ label: 'Bridging to Solana', fee: 0.3, node: at('Solana') }); cur = 'Solana' }
  if (swA) st.push({ label: `Swapping ${m.ft} → USDC`, fee: swFee(m.ft), node: nodes.indexOf('swapA') })
  const dest = T.g === 'chain' ? T.n : T.ch
  if (cur !== dest) st.push({ label: `Bridging to ${dest}`, fee: 0.5, node: T.g === 'chain' ? L : at(dest) })
  if (swB) st.push({ label: `Swapping USDC → ${m.tt}`, fee: swFee(m.ft), node: nodes.indexOf('swapB') })
  if (T.g === 'app') st.push({ label: `Depositing ${m.tt} to ${T.n}`, fee: 0.05, node: L })
  if (!st.length) st.push({ label: `Moving to ${T.n}`, fee: 0.01, node: L })
  st[st.length - 1].node = L
  return { nodes, steps: st, fee: st.reduce((x, y) => x + y.fee, 0) }
}

export function check(m: MoveInput) {
  const a = amt(m.amount), b = bal(m.from, m.ft), P = plan(m)
  const rec = Math.max(0, (a * PX[m.ft] - P.fee) / PX[m.tt])
  return { a, bal: b, rec, P, over: a > b, ok: a > 0 && a <= b && rec > 0 }
}

export type ListItem = { grp: 'Apps' | 'Chains' } | Endpoint
// From lists funded endpoints first (by balance); To keeps fixture order.
export function list(side: 'f' | 't'): ListItem[] {
  const out: ListItem[] = []
  for (const g of ['app', 'chain'] as const) {
    let l = ALL.filter((x) => x.g === g)
    if (side === 'f') l = [...l.filter((x) => hasBal(x.k)).sort((p, q) => q.b - p.b), ...l.filter((x) => !hasBal(x.k))]
    out.push({ grp: g === 'app' ? 'Apps' : 'Chains' }, ...l)
  }
  return out
}
