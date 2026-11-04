'use client'

import Image from 'next/image'
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { colors } from '@/lib/tokens'
import { STRIP_STEPS, TILE_DEFS, TIMELINE_STEPS, nextTick } from './clarity-data'
import s from './landing.module.css'

export { TICK_MS, nextTick } from './clarity-data'

const useIso = typeof window === 'undefined' ? useEffect : useLayoutEffect

/** 2. App-in-motion strip between hero and feed: one shared cadence lights the phones. */
export function Strip({ tick, reduced }: { tick: number; reduced: boolean }) {
  const [sel, setSel] = useState(0)
  const tabs = useRef<(HTMLButtonElement | null)[]>([])
  const lit = reduced ? 0 : tick
  const select = (i: number, focus = false) => {
    setSel(i)
    if (focus) tabs.current[i]?.focus()
  }
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const nav = { ArrowRight: nextTick(i), ArrowLeft: (i + 2) % 3, Home: 0, End: 2 } as const
    const n = nav[e.key as keyof typeof nav]
    if (n !== undefined) {
      e.preventDefault()
      select(n, true)
    }
  }
  return (
    <section className={s.v2Strip} aria-label="From reading to acting, in one flow">
      <div className={s.v2Phones}>
        <div className={s.v2Rail} aria-hidden>
          <b style={{ left: `calc(${lit * 50}% - 6px)` }} />
        </div>
        {STRIP_STEPS.map((p, i) => (
          <div key={p.img} className={`${s.v2Ph} ${lit === i ? s.v2Lit : ''}`}>
            <div className={s.v2Fr}>
              <Image src={p.img} alt="" width={p.w} height={p.h} unoptimized />
            </div>
            <div className={s.v2Cap}>
              <i aria-hidden>{i + 1}</i>
              {p.cap}
            </div>
          </div>
        ))}
      </div>
      <div className={s.v2Mob}>
        <div className={s.v2Tabs} role="tablist" aria-label="How MyBoon works">
          {STRIP_STEPS.map((p, i) => (
            <button
              key={p.img}
              type="button"
              role="tab"
              id={`v2t-${i}`}
              aria-controls="v2p"
              aria-selected={sel === i}
              tabIndex={sel === i ? 0 : -1}
              ref={(el) => {
                tabs.current[i] = el
              }}
              onClick={() => select(i)}
              onKeyDown={(e) => onKey(e, i)}
            >
              <i aria-hidden>{i + 1}</i>
              {p.cap}
            </button>
          ))}
        </div>
        <div className={s.v2Mfr} id="v2p" role="tabpanel" aria-labelledby={`v2t-${sel}`}>
          {STRIP_STEPS.map((p, i) => (
            <Image key={p.img} className={sel === i ? s.v2Lit : ''} src={p.img} alt={p.alt} width={p.w} height={p.h} unoptimized />
          ))}
        </div>
      </div>
    </section>
  )
}

const mono = { fontFamily: 'var(--m)' } as const

/** 3. Labelled app tiles with mini-charts, after the apps burst. */
const Odds = () => (
  <svg viewBox="0 0 220 46" preserveAspectRatio="none" aria-hidden>
    <rect x="0" y="14" width="100%" height="12" rx="6" fill={colors.backgroundDark} />
    <rect x="0" y="14" width="62%" height="12" rx="6" fill={colors.viridian} />
    <text x="0" y="44" fill={colors.textDim} style={mono} fontSize="11">YES 62%</text>
  </svg>
)
const Perps = () => (
  <svg viewBox="0 0 220 46" preserveAspectRatio="none" aria-hidden>
    <polyline points="0,38 30,30 60,34 90,18 120,22 150,8 180,12 210,4" fill="none" stroke={colors.viridian} strokeWidth="2" />
    <text x="0" y="12" fill={colors.viridian} style={mono} fontSize="11">LONG 5×</text>
  </svg>
)
const Spot = () => (
  <svg viewBox="0 0 220 46" preserveAspectRatio="none" aria-hidden>
    <rect x="0" y="8" width="44%" height="28" rx="6" fill={colors.backgroundDark} />
    <rect x="56%" y="8" width="44%" height="28" rx="6" fill={colors.backgroundDark} />
    <text x="12" y="27" fill={colors.bone} style={mono} fontSize="12">SOL</text>
    <text x="47%" y="27" fill={colors.viridian} style={mono} fontSize="13">→</text>
    <text x="61%" y="27" fill={colors.bone} style={mono} fontSize="12">USDC</text>
  </svg>
)
const Earn = () => (
  <svg viewBox="0 0 220 46" preserveAspectRatio="none" aria-hidden>
    <rect x="0" y="30" width="12%" height="10" fill={colors.borderMuted} />
    <rect x="18%" y="24" width="12%" height="16" fill={colors.borderMuted} />
    <rect x="36%" y="18" width="12%" height="22" fill={colors.borderMuted} />
    <rect x="54%" y="12" width="12%" height="28" fill={colors.viridian} />
    <text x="72%" y="30" fill={colors.viridian} style={mono} fontSize="12">+APY</text>
  </svg>
)
const VIZ = { odds: <Odds />, perps: <Perps />, spot: <Spot />, earn: <Earn /> } as const

export function Tiles() {
  return (
    <section className={s.v2Tiles} aria-label="Where you can act">
      {TILE_DEFS.map((t) => (
        <div key={t.name} className={s.v2Tile}>
          <div className={s.v2TileH}>
            <Image src={t.logo} alt="" width={32} height={32} unoptimized />
            {t.name}
          </div>
          <span className={s.v2TileK}>{t.kind}</span>
          {VIZ[t.viz]}
        </div>
      ))}
    </section>
  )
}

/** 5+6. Sample "Why it moved" story card with a ticked timeline, after Feed. */
export function Story({ tick, reduced }: { tick: number; reduced: boolean }) {
  const [open, setOpen] = useState(true)
  const toggle = (e: { target: EventTarget | null }) => {
    if ((e.target as HTMLElement | null)?.closest('button')) return
    setOpen((o) => !o)
  }
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    if ((e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    setOpen((o) => !o)
  }
  const lit = reduced ? 0 : tick
  return (
    <section className={s.v2Story} aria-label="Why it moved">
      <div
        className={`${s.v2Sc} ${open ? s.v2Open : ''}`}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={onKey}
      >
        <div className={s.v2ScTop}>
          <span>● Why it moved · Sample</span>
          <i className={s.v2Plus} aria-hidden>+</i>
        </div>
        <h4>SOL clears $180 as ETF inflows hit a weekly high</h4>
        <div className={s.v2More}>
          <div>
            <div className={s.v2Chips}>
              <span>ETF flows <b>+$312M</b></span>
              <span>DEX volume <b>+41%</b></span>
              <span>Short squeeze <b>$58M</b></span>
            </div>
            <svg className={s.v2Chart} viewBox="0 0 500 90" preserveAspectRatio="none" aria-hidden>
              <line x1="0" y1="70" x2="500" y2="70" stroke={colors.borderMuted} strokeDasharray="3 5" />
              <polyline
                points="0,72 60,68 120,70 180,60 240,62 300,44 360,38 420,22 500,12"
                fill="none"
                stroke={colors.viridian}
                strokeWidth="2.5"
              />
              <circle cx="500" cy="12" r="4" fill={colors.viridian} />
            </svg>
            <div className={s.v2Act}>
              <span>$178.40 ▲ 6.2%</span>
              <button type="button">Swap SOL</button>
            </div>
          </div>
        </div>
      </div>
      <ol className={s.v2Tl}>
        {TIMELINE_STEPS.map((x, i) => (
          <li key={x.time} className={`${s.v2TlStep} ${i <= lit ? s.v2Lit : ''}`}>
            <time className={s.v2TlTime}>{x.time}</time>
            <span className={s.v2TlLbl}>{x.label}</span>
          </li>
        ))}
      </ol>
    </section>
  )
}

const fmt = (n: number) => `$${n.toLocaleString('en-US')}`

/** 4. Portfolio card with the $50 chip sliding Polymarket → Pacifica. */
export function WalletFlow({ reduced }: { reduced: boolean }) {
  const card = useRef<HTMLDivElement>(null)
  const fromRef = useRef<HTMLLIElement>(null)
  const toRef = useRef<HTMLLIElement>(null)
  const [cycle, setCycle] = useState(0)
  const [st, setSt] = useState({ from: 1240, to: 1400, dn: false, upc: false, y: 0, trans: false, show: true })
  const yOf = (el: HTMLElement | null) => (el ? el.offsetTop + (el.offsetHeight - 24) / 2 : 0)

  // One run per cycle: park at Polymarket, slide to Pacifica, fade out.
  useIso(() => {
    const f = fromRef.current
    const t = toRef.current
    if (!f || !t) return
    setSt({ from: 1240, to: 1400, dn: false, upc: false, y: yOf(f), trans: false, show: true })
    if (reduced) return
    let raf = 0
    raf = requestAnimationFrame(() => setSt({ from: 1190, to: 1400, dn: true, upc: false, y: yOf(t), trans: true, show: true }))
    const a = window.setTimeout(() => setSt({ from: 1190, to: 1450, dn: true, upc: true, y: yOf(t), trans: true, show: true }), 1200)
    const b = window.setTimeout(() => setSt((p) => ({ ...p, show: false })), 2700)
    return () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(a)
      window.clearTimeout(b)
    }
  }, [cycle, reduced])

  // Loop every 3.2s on desktop; on phones only while the card is on screen.
  useEffect(() => {
    if (reduced) return
    const el = card.current
    if (!el) return
    let id: number | undefined
    const start = () => {
      if (id === undefined) id = window.setInterval(() => setCycle((c) => c + 1), 3200)
    }
    const stop = () => {
      if (id !== undefined) {
        window.clearInterval(id)
        id = undefined
      }
    }
    const phone = window.matchMedia('(max-width: 767px)').matches
    if (phone) {
      const io = new IntersectionObserver((es) => es.forEach((x) => (x.isIntersecting ? start() : stop())), { threshold: 0.4 })
      io.observe(el)
      return () => {
        io.disconnect()
        stop()
      }
    }
    start()
    return stop
  }, [reduced])

  const rows = [
    ['Polymarket', '/landing/logo-polymarket.svg'],
    ['Phoenix', '/landing/logo-phoenix.svg'],
    ['Pacifica', '/landing/logo-pacifica.svg'],
  ] as const
  return (
    <div ref={card} className={`${s.card} ${s.pf}`}>
      <div className={s.tag}>
        <span>Total balance</span>
        <span className={s.pill}>Example</span>
      </div>
      <p className={s.total}>$4,820.15</p>
      <span className={s.up}><span aria-hidden>▲</span> $126.40 today</span>
      <ul>
        <li ref={fromRef}>
          <Image src={rows[0][1]} alt="" width={24} height={24} unoptimized />
          {rows[0][0]}
          <b className={`${s.v2Tick} ${st.dn ? s.v2Dn : ''}`}>{fmt(st.from)}</b>
        </li>
        <li>
          <Image src={rows[1][1]} alt="" width={24} height={24} unoptimized />
          {rows[1][0]}
          <b>$2,180</b>
        </li>
        <li ref={toRef}>
          <Image src={rows[2][1]} alt="" width={24} height={24} unoptimized />
          {rows[2][0]}
          <b className={`${s.v2Tick} ${st.upc ? s.v2Upc : ''}`}>{fmt(st.to)}</b>
        </li>
      </ul>
      <span
        className={s.v2Chip}
        aria-hidden
        style={{ top: st.y, transition: st.trans ? undefined : 'none', opacity: st.show ? 1 : 0 } as CSSProperties}
      >
        $50
      </span>
    </div>
  )
}
