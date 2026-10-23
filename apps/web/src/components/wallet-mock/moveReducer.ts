import { BY, bal, dec, fT, hasBal, toks, type Token } from './data'
import { amt, check, plan } from './route'

export type Side = 'f' | 't'
export type MoveState = { from: string; to: string; ft: Token; tt: Token; amount: string; stage: 'ready' | 'pending' | 'success'; step: number; note: Record<Side, string> }
export type MoveAction =
  | { type: 'pick'; side: Side; k: string }
  | { type: 'cycleToken'; side: Side }
  | { type: 'amount'; value: string }
  | { type: 'pct'; pct: number }
  | { type: 'clearNote'; side: Side }
  | { type: 'run' } | { type: 'tick' } | { type: 'reset' }

export const initialMove = (): MoveState => ({ from: 'polymarket', to: 'pacifica', ft: 'USDC', tt: 'USDC', amount: '100.00', stage: 'ready', step: 0, note: { f: '', t: '' } })

export function moveReducer(s: MoveState, a: MoveAction): MoveState {
  if (a.type === 'reset') return { ...s, stage: 'ready', step: 0 }
  if (a.type === 'tick') {
    if (s.stage !== 'pending') return s
    return s.step < plan(s).steps.length - 1 ? { ...s, step: s.step + 1 } : { ...s, stage: 'success' }
  }
  if (a.type === 'clearNote') return { ...s, note: { ...s.note, [a.side]: '' } }
  if (s.stage !== 'ready') return s
  switch (a.type) {
    case 'run': return check(s).ok ? { ...s, stage: 'pending', step: 0 } : s
    case 'amount': {
      let v = a.value.replace(',', '.').replace(/[^\d.]/g, '')
      const p = v.split('.')
      if (p.length > 2) v = p[0] + '.' + p.slice(1).join('')
      const d = dec(s.ft), q = v.split('.')
      if (q[1] && q[1].length > d) v = q[0] + '.' + q[1].slice(0, d)
      return { ...s, amount: v }
    }
    case 'pct': {
      const m = 10 ** dec(s.ft)
      return { ...s, amount: (Math.floor((bal(s.from, s.ft) * a.pct) / 100 * m) / m).toFixed(dec(s.ft)) }
    }
    case 'cycleToken': {
      const k = a.side === 'f' ? s.from : s.to, l = toks(k)
      if (l.length < 2) return s
      const cur = a.side === 'f' ? s.ft : s.tt, next = l[(l.indexOf(cur) + 1) % l.length]
      if (a.side === 't') return { ...s, tt: next }
      const b = bal(s.from, next)
      return { ...s, ft: next, amount: b < amt(s.amount) ? fT(b, next).replace(/,/g, '') : s.amount }
    }
    case 'pick': {
      const { k, side } = a
      if (side === 'f') {
        if (!hasBal(k)) return { ...s, note: { ...s.note, f: `${BY[k].n} has nothing to move` } }
        const to = k === s.to ? s.from : s.to // picking the current To as From swaps the pair
        const ft = toks(k).includes(s.ft) && bal(k, s.ft) ? s.ft : toks(k).find((t) => bal(k, t) > 0) || 'USDC'
        return { ...s, from: k, to, ft, tt: toks(to).includes(s.tt) ? s.tt : 'USDC', note: { ...s.note, f: '' } }
      }
      if (k === s.from) return { ...s, note: { ...s.note, t: `${BY[k].n} is already your From` } }
      return { ...s, to: k, tt: toks(k).includes(s.tt) ? s.tt : 'USDC', note: { ...s.note, t: '' } }
    }
  }
  return s
}
