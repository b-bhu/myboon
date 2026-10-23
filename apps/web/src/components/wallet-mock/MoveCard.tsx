'use client'
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
import { BY, COL, bal, f2, fT, hasBal, toks } from './data'
import { Icon, Mark, Tk } from './icons'
import { initialMove, moveReducer, type MoveState, type Side } from './moveReducer'
import { check, hop, list } from './route'
import { useSwipe } from './useSwipe'

type Pin = { side: Side; edge: 'top' | 'bottom'; x: number; y: number }
type Geo = { d: string; mid: { x: number; y: number } | null; pins: Pin[] } | null

const label = (n: string) => { const p = n.split(' '); return p.length > 1 && n.length > 11 ? { a: p[0], b: p.slice(1).join(' ') } : { a: n, b: null } }

export function MoveCard({ initialScroll }: { initialScroll?: 'from' | 'to' }) {
  const [s, dispatch] = useReducer(moveReducer, undefined, initialMove)
  const bay = useRef<HTMLDivElement>(null), rf = useRef<HTMLDivElement>(null), rt = useRef<HTMLDivElement>(null)
  const [geo, setGeo] = useState<Geo>(null)
  const c = check(s), h = hop(s.from, s.to)

  // Measured connector: selected row if visible, else a pinned tab on the column edge it scrolled past.
  const draw = useCallback(() => {
    const B = bay.current?.getBoundingClientRect()
    const cols = [rf.current, rt.current]
    if (!B || !cols[0] || !cols[1]) return
    const pins: Pin[] = []
    const pts = (['f', 't'] as const).map((side, i) => {
      const col = cols[i]!, row = col.querySelector('.mv-row.on')
      if (!row) return null
      const R = row.getBoundingClientRect(), C = col.getBoundingClientRect()
      const edge = R.top < C.top - 2 ? 'top' : R.bottom > C.bottom - 30 ? 'bottom' : null
      if (!edge) return { x: (side === 'f' ? R.right : R.left) - B.left, y: R.top + R.height / 2 - B.top }
      const y = (edge === 'top' ? C.top + 4 : C.bottom - 34) - B.top, x = (side === 'f' ? C.right - 30 : C.left + 4) - B.left
      pins.push({ side, edge, x, y })
      return { x: side === 'f' ? x + 26 : x, y: y + 13 }
    })
    const [A, Z] = pts
    if (!A || !Z) return setGeo(null)
    const mx = (A.x + Z.x) / 2
    const next: Geo = { d: `M${A.x} ${A.y} C${mx} ${A.y} ${mx} ${Z.y} ${Z.x} ${Z.y}`, mid: h ? { x: mx, y: (A.y + Z.y) / 2 } : null, pins }
    setGeo((g) => (JSON.stringify(g) === JSON.stringify(next) ? g : next))
  }, [h])

  useLayoutEffect(() => {
    ;[rf.current, rt.current].forEach((r, i) => {
      const o = r?.querySelector<HTMLElement>('.mv-row.on')
      if (r && o) r.scrollTop = Math.max(0, o.offsetTop - r.offsetTop - 80)
      if (r && initialScroll === (i ? 'to' : 'from')) r.scrollTop = 9999
    })
  }, [initialScroll])
  useLayoutEffect(draw)
  useEffect(() => {
    const cols = [rf.current!, rt.current!]
    cols.forEach((r) => r.addEventListener('scroll', draw, { passive: true }))
    window.addEventListener('resize', draw)
    const io = new IntersectionObserver(draw, { threshold: [0, 0.5, 1] })
    cols.forEach((r) => r.querySelectorAll('.mv-row.on').forEach((el) => io.observe(el)))
    return () => { cols.forEach((r) => r.removeEventListener('scroll', draw)); window.removeEventListener('resize', draw); io.disconnect() }
  }, [draw, s.from, s.to])

  useEffect(() => { if (s.stage !== 'pending') return; const t = setTimeout(() => dispatch({ type: 'tick' }), 1400); return () => clearTimeout(t) }, [s.stage, s.step])
  useEffect(() => { const t = (['f', 't'] as const).filter((k) => s.note[k]).map((k) => setTimeout(() => dispatch({ type: 'clearNote', side: k }), 2600)); return () => t.forEach(clearTimeout) }, [s.note])

  const swipe = useSwipe(() => dispatch({ type: 'run' }), s.stage === 'ready' && c.ok)
  const scrollBack = (side: Side) => {
    const r = side === 'f' ? rf.current : rt.current, o = r?.querySelector<HTMLElement>('.mv-row.on')
    if (r && o) r.scrollTo({ top: Math.max(0, o.offsetTop - r.offsetTop - 80), behavior: 'smooth' })
  }

  return (
    <div className="composer mv" id="mvc">
      <div className="mv-bay" ref={bay}>
        <Column side="f" s={s} rows={rf} onPick={(k) => dispatch({ type: 'pick', side: 'f', k })} onTok={() => dispatch({ type: 'cycleToken', side: 'f' })} />
        <div />
        <Column side="t" s={s} rows={rt} onPick={(k) => dispatch({ type: 'pick', side: 't', k })} onTok={() => dispatch({ type: 'cycleToken', side: 't' })} />
        <svg className="mv-wire" aria-hidden="true">{geo && <path d={geo.d} stroke="#FFD166" strokeWidth={2} fill="none" />}</svg>
        {geo?.mid && h && <span className="mv-hop" style={{ left: geo.mid.x, top: geo.mid.y, borderColor: COL[h] || '#A9C3CC' }}><Mark k={h} /></span>}
        {geo?.pins.map((p) => (
          <button key={p.side} className="mv-pin" data-edge={p.edge} style={{ left: p.x, top: p.y }} onClick={() => scrollBack(p.side)}
            aria-label={`Selected ${BY[p.side === 'f' ? s.from : s.to].n}, scroll to it`}><Mark k={p.side === 'f' ? s.from : s.to} /></button>
        ))}
      </div>
      <div className={`mv-amt ${c.over ? 'err' : ''}`}>
        <label className="sr-only" htmlFor="mv-amt">Amount in {s.ft}</label>
        <input className="mv-in" id="mv-amt" inputMode="decimal" autoComplete="off" placeholder="0.00" value={s.amount} aria-invalid={c.over}
          readOnly={s.stage !== 'ready'} onChange={(e) => dispatch({ type: 'amount', value: e.target.value })} />
        <div className="unit">{s.ft}</div>
        <div className="sub" id="mv-sub"><Mark k={s.from} /><Tk t={s.ft} /><b>{fT(c.bal, s.ft)}</b><span className="ar">→</span><Mark k={s.to} /><Tk t={s.tt} /><b>≈{fT(c.rec, s.tt)}</b></div>
        <div className="mv-chips">{[25, 50, 75, 100].map((p) => <button key={p} disabled={s.stage !== 'ready'} onClick={() => dispatch({ type: 'pct', pct: p })}>{p === 100 ? 'Max' : p + '%'}</button>)}</div>
      </div>
      <RouteRow s={s} />
      <MoveSwipe s={s} swipe={swipe} onDone={() => dispatch({ type: 'reset' })} onKey={() => dispatch({ type: 'run' })} />
    </div>
  )
}

function Column({ side, s, rows, onPick, onTok }: { side: Side; s: MoveState; rows: React.RefObject<HTMLDivElement | null>; onPick: (k: string) => void; onTok: () => void }) {
  const k = side === 'f' ? s.from : s.to, cur = side === 'f' ? s.ft : s.tt, l = toks(k)
  return (
    <div id={'c' + side}>
      <div className="mv-ch"><b>{side === 'f' ? 'From' : 'To'}</b></div>
      <p className={`mv-note ${s.note[side] ? 'show' : ''}`} aria-live="polite">{s.note[side]}</p>
      <div className="mv-rows" id={'r' + side} ref={rows}>
        {list(side).map((x) => {
          if ('grp' in x) return <div key={x.grp} className="mv-grp" aria-hidden="true">{x.grp}</div>
          const sel = k === x.k, off = side === 't' ? x.k === s.from : !hasBal(x.k), lb = label(x.n)
          return (
            <button key={x.k} className={`mv-row ${sel ? 'on' : ''} ${off ? 'off' : ''}`} data-k={x.k} aria-pressed={sel} aria-disabled={off || undefined} onClick={() => s.stage === 'ready' && onPick(x.k)}>
              <Mark k={x.k} />
              <span className="t"><strong>{side === 't' ? lb.a : x.n}</strong>
                {side === 'f' ? <small>{sel ? fT(bal(x.k, s.ft), s.ft) + (s.ft !== 'USDC' ? ' ' + s.ft : '') : f2(x.b)}</small> : lb.b && <small className="w">{lb.b}</small>}
              </span>
            </button>
          )
        })}
      </div>
      <div className="mv-tok" aria-label={`${side === 'f' ? 'From' : 'To'} token`}>
        {l.length < 2
          ? <span className="s"><Tk t={l[0]} />{l[0]}</span>
          : <button className="on" onClick={onTok} disabled={s.stage !== 'ready'} aria-label={`${cur}, tap to switch token`}>
              <span key={cur} className="mv-fade"><Tk t={cur} />{cur}</span><Icon name="cycle" className="cyc" w={2.4} />
            </button>}
      </div>
    </div>
  )
}

function lit(s: MoveState) {
  if (s.stage === 'success') return 99
  if (s.stage !== 'pending') return -1
  const P = check(s).P
  return s.step > 0 ? P.steps[s.step - 1].node : 0
}

function RouteRow({ s }: { s: MoveState }) {
  const { P } = check(s), L = lit(s)
  return (
    <div className="mv-route" data-live={s.stage !== 'ready' || undefined} aria-label="Route">
      {P.nodes.map((k, i) => <span key={k + i} style={{ display: 'contents' }}>{i > 0 && <i className={i <= L ? 'lit' : ''} />}<Mark k={k} className={i <= L ? 'lit' : ''} /></span>)}
    </div>
  )
}

function MoveSwipe({ s, swipe, onDone, onKey }: { s: MoveState; swipe: ReturnType<typeof useSwipe>; onDone: () => void; onKey: () => void }) {
  const c = check(s), P = c.P, T = BY[s.to]
  let lab: string, det: React.ReactNode, glyph: 'arrow' | 'spin' | 'check'
  if (s.stage === 'ready') { lab = 'Swipe to move'; det = c.over ? `More than the ${fT(c.bal, s.ft)} ${s.ft} available` : c.ok ? `${fT(c.a, s.ft)} ${s.ft} to ${T.n}` : 'Enter an amount'; glyph = 'arrow' }
  else if (s.stage === 'pending') { const x = P.steps[s.step]; lab = `Step ${s.step + 1} of ${P.steps.length}`; det = <><Mark k={P.nodes[x.node]} />{x.label}</>; glyph = 'spin' }
  else { lab = 'Done · example · tap to start again'; det = <><Mark k={s.to} />≈{fT(c.rec, s.tt)} {s.tt} in {T.n}</>; glyph = 'check' }
  const done = s.stage === 'pending' ? (s.step + 0.5) / P.steps.length : 0
  return (
    <button className="swipe" id="mv-swipe" data-stage={s.stage} disabled={s.stage === 'ready' && !c.ok} aria-live="polite"
      style={{ ['--done' as string]: done }} {...swipe}
      onClick={(e) => { if (s.stage === 'success') onDone(); else if (e.detail === 0 && s.stage === 'ready') onKey() }}>
      <span className="swipe-fill" aria-hidden="true" />
      <span className="swipe-label">{lab}<strong>{det}</strong></span>
      <span className="swipe-thumb" aria-hidden="true"><Icon name={glyph} w={2.2} /></span>
    </button>
  )
}
