'use client'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Icon } from './icons'
import { MoveCard } from './MoveCard'
import { ReceiveCard, SendCard } from './SendReceive'
import { SwapCard } from './SwapCard'

const MODES = ['move', 'swap', 'send', 'receive'] as const
type Mode = (typeof MODES)[number]

export function WalletScreen() {
  const q = useSearchParams()
  const qm = q.get('mode') as Mode
  const [mode, setMode] = useState<Mode>(MODES.includes(qm) ? qm : 'move')
  const top = useRef<HTMLDivElement>(null), scroller = useRef<HTMLDivElement>(null), outer = useRef<HTMLElement>(null)
  const [rest, setRest] = useState(400), [h, setH] = useState(0), [radius, setRadius] = useState(50)
  const radiusFor = (el: HTMLDivElement | null, r: number) => { const p = r && el ? Math.min(1, el.scrollTop / r) : 0; return (el?.clientWidth ?? 390) * 0.14 * (1 - p) }

  // Accounts panel scrolls over the action card, as in the reference Wallet.
  useLayoutEffect(() => {
    const m = () => { const r = Math.max(0, (top.current?.offsetHeight ?? 416) - 16); setRest(r); setH(outer.current?.clientHeight ?? 0); setRadius(radiusFor(scroller.current, r)) }
    m(); const ro = new ResizeObserver(m); if (top.current) ro.observe(top.current); if (outer.current) ro.observe(outer.current)
    return () => ro.disconnect()
  }, [])
  useEffect(() => { const u = new URL(location.href); u.searchParams.set('mode', mode); history.replaceState(null, '', u) }, [mode])

  const sc = q.get('scroll')
  return (
    <main className="wallet-scroll" ref={outer}>
      <div className="wallet-top" ref={top}>
        <section className="action-zone" aria-label="Wallet action">
          <nav className="mv-modes" aria-label="Wallet mode">
            {MODES.map((m) => <button key={m} aria-pressed={m === mode} onClick={() => setMode(m)}><Icon name={m} w={2.2} />{m[0].toUpperCase() + m.slice(1)}</button>)}
          </nav>
          {mode === 'move' ? <MoveCard initialScroll={sc === 'from' || sc === 'to' ? sc : undefined} /> : mode === 'swap' ? <SwapCard /> : mode === 'send' ? <SendCard /> : <ReceiveCard />}
        </section>
      </div>
      <div className="market-scroll" ref={scroller} onScroll={(e) => setRadius(radiusFor(e.currentTarget, rest))}>
        <div className="market-spacer" style={{ height: rest }} aria-hidden="true" />
        <Accounts minHeight={h} radius={radius} />
      </div>
    </main>
  )
}

type Tab = 'spot' | 'perps' | 'meteora'
const ROWS: Record<Tab, { head: [string, string, string]; rows: [string, string, string, string, string, string?][] }> = {
  spot: { head: ['Markets', 'Your spot balance', '$8,420.00'], rows: [['S', 'Solana', '20 SOL held', '$157.42', '+2.1%'], ['$', 'USD Coin', '4,743.6 USDC held', '$1.00', '0.0%', 'quiet'], ['J', 'Jupiter', '600 JUP held', '$0.88', '+1.3%'], ['₿', 'Bitcoin', 'BTC · No holdings', '$68,720.00', '+1.4%']] },
  perps: { head: ['Your positions', 'Account equity', '$1,650.00'], rows: [['S', 'SOL-PERP', 'Long · 3× · Phoenix', '$950.00', '+12.40 PnL'], ['₿', 'BTC-PERP', 'Short · 2× · Pacifica', '$700.00', '−4.12 PnL', 'negative']] },
  meteora: { head: ['Your pools', 'Liquidity value', '$2,412.56'], rows: [['S', 'SOL / USDC', 'In range', '$1,460.00', '$8.44 fees', 'quiet'], ['J', 'JUP / USDC', 'Out of range', '$952.56', '$3.18 fees', 'quiet']] },
}
function Accounts({ minHeight, radius }: { minHeight: number; radius: number }) {
  const [tab, setTab] = useState<Tab>('spot'), d = ROWS[tab]
  return (
    <section className="market-panel" style={{ minHeight: minHeight || undefined, ['--panel-radius' as string]: radius + 'px' }} aria-label="Markets and positions">
      <div className="market-toolbar">
        <div className="market-tabs" role="tablist">
          {(['spot', 'perps', 'meteora'] as const).map((t) => <button key={t} role="tab" aria-selected={t === tab} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</button>)}
        </div>
      </div>
      <div className="market-content">
        <div className="panel-heading"><h2>{d.head[0]}</h2><p>{d.head[1]}<strong>{d.head[2]}</strong></p></div>
        {d.rows.map(([g, n, sub, v, ch, cls]) => (
          <div key={n} className="market-row">
            <span className={`coin ${g === 'S' ? 'sol' : ''}`} aria-hidden="true">{g === 'S' ? <Icon name="sol" /> : g}</span>
            <span className="row-identity"><strong>{n}</strong><small>{sub}</small></span>
            <span className="row-numbers"><strong>{v}</strong><small className={cls ?? 'positive'}>{ch}</small></span>
          </div>
        ))}
      </div>
    </section>
  )
}
