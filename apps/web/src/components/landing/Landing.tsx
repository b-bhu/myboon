'use client'
import Image from 'next/image'
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type CSSProperties, type PointerEvent, type KeyboardEvent, type ReactNode } from 'react'
import { PolicyLinks } from '@/components/policy/PolicyLinks'
import { colors, colorVars, usdcBlue } from '@/lib/tokens'
import { appTiles, crops, STORE_URL, X_URL, type Place } from './data'
import { curve, type Pt } from './route'
import { initialSlider, RESET_MS, sliderReducer } from './slider'
import s from './landing.module.css'

const MOBILE_BP = 600
const useIso = typeof window === 'undefined' ? useEffect : useLayoutEffect
const isMobile = () => window.matchMedia(`(max-width: ${MOBILE_BP - 1}px)`).matches
const DOTTED = { fill: 'none', strokeWidth: 2.2, strokeDasharray: '1 7', strokeLinecap: 'round' } as const

function useReducedMotion() {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    const q = window.matchMedia('(prefers-reduced-motion: reduce)')
    const on = () => setReduced(q.matches)
    on()
    q.addEventListener('change', on)
    return () => q.removeEventListener('change', on)
  }, [])
  return reduced
}

/** Position vars for an element placed by centre %, with an optional mobile placement. */
function place(d: Place, m?: Place | null): CSSProperties {
  const v: Record<string, string> = { '--x': `${d.x}%`, '--y': `${d.y}%`, '--w': `${d.w}px`, '--r': `${d.r}deg` }
  if (m) Object.assign(v, { '--mx': `${m.x}%`, '--my': `${m.y}%`, '--mw': `${m.w}px`, '--mr': `${m.r}deg` })
  return v as CSSProperties
}

const Arrow = () => (
  <svg viewBox="0 0 24 24" aria-hidden>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
)

function Ctas() {
  return (
    <div className={s.ctas}>
      <a className={s.store} href={STORE_URL}>
        <Image src="/wallet-mock/solana.svg" alt="" width={30} height={30} unoptimized />
        <span>
          <small>Get it on the</small>
          <b>Solana dApp Store</b>
        </span>
      </a>
      <a className={s.try} href="#try">
        Give it a try
        <Arrow />
      </a>
    </div>
  )
}

const Pill = ({ children = 'Example' }: { children?: ReactNode }) => <span className={s.pill}>{children}</span>
const Usdc = () => <i className={`${s.tk} ${s.usdc}`} aria-hidden>$</i>
const Sol = () => <Image className={s.tk} src="/wallet-mock/solana.svg" alt="" width={20} height={20} unoptimized />

/** Slide-to-confirm: drag the knob, or focus it and press Enter or Space. Resets after a moment. */
function Slider({ label, ok }: { label: string; ok: string }) {
  const [st, send] = useReducer(sliderReducer, initialSlider)
  const track = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x0: number; max: number } | null>(null)

  useEffect(() => {
    if (st.phase !== 'done') return
    const t = window.setTimeout(() => send({ type: 'reset' }), RESET_MS)
    return () => window.clearTimeout(t)
  }, [st.phase])

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (st.phase === 'done') return
    drag.current = { x0: e.clientX, max: (track.current?.clientWidth ?? 0) - 52 }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (d && d.max > 0) send({ type: 'drag', p: (e.clientX - d.x0) / d.max })
  }
  const up = () => {
    if (!drag.current) return
    drag.current = null
    send({ type: 'release' })
  }
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight') e.preventDefault()
    send({ type: 'key', key: e.key })
  }

  const done = st.phase === 'done'
  return (
    <div
      ref={track}
      className={`${s.slider} ${done ? s.done : ''} ${st.phase === 'dragging' ? s.dragging : ''}`}
      style={{ '--p': st.p } as CSSProperties}
    >
      <div className={s.fill} aria-hidden />
      <div className={s.lbl} aria-live="polite">{done ? ok : label}</div>
      <div
        className={s.knob}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(st.p * 100)}
        aria-valuetext={done ? ok : `${Math.round(st.p * 100)}%`}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onKeyDown={key}
      >
        <Arrow />
      </div>
    </div>
  )
}

function StoryCard({ tag, title, body, why, icon = '●' }: { tag: string; title: string; body: string; why?: string[]; icon?: string }) {
  return (
    <article className={`${s.card} ${s.story}`}>
      <div className={s.tag}>
        <span><span aria-hidden>{icon}</span> {tag}</span>
        <Pill>Sample</Pill>
      </div>
      <p className={s.title}>{title}</p>
      <p>{body}</p>
      {why && (
        <div className={s.why}>
          {why.map((w) => <span key={w}>{w}</span>)}
        </div>
      )}
    </article>
  )
}

function PriceCard() {
  return (
    <div className={`${s.card} ${s.price}`}>
      <Image src="/wallet-mock/solana.svg" alt="" width={34} height={34} unoptimized />
      <div>
        <b>$178.40</b>
        <span className={s.up}><span aria-hidden>▲</span> 6.2%</span>
      </div>
      <svg className={s.spark} width="56" height="26" viewBox="0 0 56 26" aria-hidden>
        <polyline points="0,22 10,18 18,20 28,11 38,13 46,5 56,3" fill="none" stroke={colors.positive} strokeWidth="2" />
      </svg>
    </div>
  )
}

function SwapCard() {
  return (
    <div className={`${s.card} ${s.swapc}`}>
      <div className={s.tag}>
        <span><span aria-hidden>⇄</span> Swap</span>
        <Pill />
      </div>
      <div className={s.row}><b>1.2</b><span><Sol />SOL</span></div>
      <div className={s.row}><b>≈ 214</b><span><Usdc />USDC</span></div>
      <Slider label="Slide to swap" ok="Swapped (example)" />
    </div>
  )
}

const MoveIcon = () => <svg viewBox="0 0 24 24" aria-hidden><path d="M4 8h13l-3-3M20 16H7l3 3" /></svg>
const SwapIcon = () => <svg viewBox="0 0 24 24" aria-hidden><path d="M7 4v16l-3-3M17 20V4l3 3" /></svg>
const SendIcon = () => <svg viewBox="0 0 24 24" aria-hidden><path d="M4 12l16-8-6 16-3-7-7-1Z" /></svg>

function MoveCard() {
  return (
    <div className={`${s.card} ${s.swapc}`}>
      <div className={s.tag}>
        <span>Polymarket → Pacifica</span>
        <Pill />
      </div>
      <div className={s.amodes} aria-hidden>
        <span className={s.on}><MoveIcon />Move</span>
        <span><SwapIcon />Swap</span>
        <span><SendIcon />Send</span>
      </div>
      <div className={s.row}><b>50</b><span><Usdc />USDC</span></div>
      <Slider label="Slide to move" ok="Moved (example)" />
    </div>
  )
}

function PortfolioCard() {
  const rows = [
    ['Polymarket', '/landing/logo-polymarket.svg', '$1,240'],
    ['Phoenix', '/landing/logo-phoenix.svg', '$2,180'],
    ['Pacifica', '/landing/logo-pacifica.svg', '$1,400'],
  ] as const
  return (
    <div className={`${s.card} ${s.pf}`}>
      <div className={s.tag}>
        <span>Total balance</span>
        <Pill />
      </div>
      <p className={s.total}>$4,820.15</p>
      <span className={s.up}><span aria-hidden>▲</span> $126.40 today</span>
      <ul>
        {rows.map(([n, logo, v]) => (
          <li key={n}>
            <Image src={logo} alt="" width={24} height={24} unoptimized />
            {n}
            <b>{v}</b>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Shot({ k }: { k: keyof typeof crops }) {
  const c = crops[k]
  return (
    <div className={s.card}>
      <Image className={s.shot} src={c.src} alt={c.alt} width={c.w} height={c.h} sizes="360px" />
    </div>
  )
}

/** A scroll-revealed section card. `node` marks it as a page-route stop ('d' desktop, 'm' mobile). */
function Tl({ d, m, node, dOnly, children }: { d: Place; m?: Place; node?: 'd' | 'm' | 'dm'; dOnly?: boolean; children: ReactNode }) {
  return (
    <div
      className={`${s.tl} ${dOnly ? s.dOnly : ''}`}
      style={place(d, m)}
      data-dp={d.dp ?? 0.2}
      data-node-d={node?.includes('d') ? '' : undefined}
      data-node-m={node?.includes('m') ? '' : undefined}
    >
      <div className={s.in}>{children}</div>
    </div>
  )
}

function Hero({ reduced }: { reduced: boolean }) {
  const ref = useRef<HTMLElement>(null)
  const [paths, setPaths] = useState({ p1: '', p2: '', all: '' })

  useIso(() => {
    const h = ref.current
    if (!h) return
    const build = () => {
      const W = h.clientWidth
      const H = h.clientHeight
      const at = (x: number, y: number): Pt => [(x * W) / 100, (y * H) / 100]
      // Blue = understand (story, price), green = act (swap).
      const b = isMobile() ? [at(50, 36)] : [at(15, 27), at(17, 71)]
      const g = [b[b.length - 1], isMobile() ? at(50, 54) : at(84, 70)]
      const pre: Pt = [-40, b[0][1] - 60]
      const post: Pt = [W + 40, g[g.length - 1][1] + 80]
      setPaths({ p1: curve([pre, ...b], 'x'), p2: curve([...g, post], 'x'), all: curve([pre, ...b, ...g.slice(1), post], 'x') })
    }
    build()
    const ro = new ResizeObserver(build)
    ro.observe(h)
    return () => ro.disconnect()
  }, [])

  return (
    <section ref={ref} className={s.hero} id="hero">
      <nav className={s.nav}>
        <Image src="/branding/myboon-wordmark-header.png" alt="MyBoon" width={420} height={218} priority />
        <a className={s.nx} href={X_URL} aria-label="MyBoon on X">
          <svg viewBox="0 0 24 24" aria-hidden>
            <path d="M18.9 2H22l-7.5 8.6L23 22h-6.8l-5.3-7-6.1 7H1.7l8-9.2L1 2h7l4.8 6.4L18.9 2Zm-1.2 18h1.9L7.4 4H5.4l12.3 16Z" />
          </svg>
        </a>
      </nav>
      <h1 className={`${s.words} ${s.heroWords}`}>
        <span className={`${s.w} ${s.echo} ${s.echoB}`} aria-hidden>Understand.</span>
        <span className={`${s.w} ${s.main}`}>Understand.</span>{' '}
        <span className={`${s.w} ${s.act}`}>Act.</span>
      </h1>
      <svg className={s.path} aria-hidden>
        <path d={paths.p1} stroke={colors.primary} {...DOTTED} />
        <path d={paths.p2} stroke={colors.viridian} {...DOTTED} />
        {paths.all && !reduced && (
          <circle className={s.dot} r={4.5} fill={colors.viridian}>
            <animateMotion dur="7s" repeatCount="indefinite" rotate="auto" path={paths.all} />
          </circle>
        )}
      </svg>
      <div className={`${s.tile} ${s.dOnly}`} style={{ ...place({ x: 15, y: 27, w: 300, r: -4 }), '--d': '5s' } as CSSProperties}>
        <StoryCard tag="Why it moved" title="SOL clears $180 as ETF inflows hit a weekly high" body="Three reasons it moved, in 20 seconds." why={['ETF flows', 'DEX volume', '+2']} />
      </div>
      <div className={s.tile} style={{ ...place({ x: 17, y: 71, w: 230, r: 3 }, { x: 50, y: 36, w: 220, r: -2 }), '--d': '5.7s', animationDelay: '-1.3s' } as CSSProperties}>
        <PriceCard />
      </div>
      <div className={s.tile} style={{ ...place({ x: 84, y: 70, w: 290, r: 3 }, { x: 50, y: 54, w: 250, r: 2 }), '--d': '6.4s', animationDelay: '-2.6s' } as CSSProperties}>
        <SwapCard />
      </div>
      <div className={s.copy}>
        <Ctas />
      </div>
    </section>
  )
}

function Words({ word, echo, className }: { word: string; echo?: boolean; className: string }) {
  return (
    <h2 className={`${s.words} ${className}`}>
      {echo && <span className={`${s.w} ${s.echo} ${s.echoB}`} aria-hidden>{word}</span>}
      <span className={`${s.w} ${s.main}`}>{word}</span>
    </h2>
  )
}

export default function Landing() {
  const reduced = useReducedMotion()
  const root = useRef<HTMLElement>(null)
  const [armed, setArmed] = useState(false)
  const [gp, setGp] = useState({ h: 0, g1: '', g2: '', all: '' })

  /** Page route: hero swap card → Feed story → left margin → Pacifica tile → Wallet card. */
  const measure = useCallback(() => {
    const el = root.current
    if (!el) return
    const m = isMobile()
    const base = el.getBoundingClientRect()
    const W = el.clientWidth
    const c = (e: Element | null): Pt | null => {
      if (!e) return null
      const r = e.getBoundingClientRect()
      return [r.left - base.left + r.width / 2, r.top - base.top + r.height / 2]
    }
    const q = (sel: string) => el.querySelector<HTMLElement>(sel)
    const hero = q('#hero')
    const feed = q('#feed')
    const hTiles = el.querySelectorAll(`#hero .${s.tile}`)
    const start = m && hero ? ([W * 0.06, hero.offsetTop + hero.offsetHeight - 12] as Pt) : c(hTiles[hTiles.length - 1])
    const story = c(q(`#feed [data-node-${m ? 'm' : 'd'}]`))
    const pac = c(q('#apps [data-node]'))
    const wal = c(q(`#wallet [data-node-${m ? 'm' : 'd'}]`))
    if (!start || !story || !pac || !wal || !feed) return
    const pts: Pt[] = [start, story, [W * (m ? 0.05 : 0.04), feed.offsetTop + feed.offsetHeight * 0.55], [W * (m ? 0.04 : 0.03), pac[1]]]
    if (m) {
      // Mobile: the route ends at the Pacifica tile's left edge instead of running behind it.
      const tile = q('#apps [data-node]')!.getBoundingClientRect()
      pts.push([tile.left - base.left - 4, pac[1]])
    } else {
      pts.push(pac, wal)
    }
    setGp({ h: el.scrollHeight, g1: curve(pts.slice(0, 3), 'y'), g2: curve(pts.slice(2), 'y'), all: curve(pts, 'y') })
  }, [])

  // Arm the tilt-in only with JS and motion allowed, so content is never hidden otherwise.
  useIso(() => {
    const el = root.current
    if (!el) return
    const tls = [...el.querySelectorAll<HTMLElement>(`.${s.tl}`)]
    let io: IntersectionObserver | undefined
    if (!reduced && 'IntersectionObserver' in window) {
      setArmed(true)
      io = new IntersectionObserver(
        (es) => es.forEach((x) => {
          if (x.isIntersecting) {
            x.target.classList.add(s.on)
            io?.unobserve(x.target)
          }
        }),
        { threshold: 0.2 },
      )
      tls.forEach((t) => io!.observe(t))
    } else {
      setArmed(false)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    document.fonts?.ready.then(measure)
    return () => {
      io?.disconnect()
      ro.disconnect()
    }
  }, [reduced, measure])

  // Very light scroll parallax on cards and app tiles (transform only, rAF-throttled).
  useEffect(() => {
    const el = root.current
    if (!el) return
    const all = () => [...el.querySelectorAll<HTMLElement>(`.${s.tl}, .${s.gt}`)]
    if (reduced) {
      all().forEach((e) => e.style.removeProperty('--py'))
      return
    }
    let raf = 0
    const tick = () => {
      raf = 0
      // Phones get no card parallax: at 390 it pushed cards into the big words and copy.
      if (isMobile()) {
        all().forEach((e) => e.style.removeProperty('--py'))
        return
      }
      const vh = window.innerHeight
      for (const e of all()) {
        const r = e.getBoundingClientRect()
        if (r.bottom < -200 || r.top > vh + 200) continue
        const c = r.top + r.height / 2 - vh / 2
        const k = e.classList.contains(s.gt) ? 0.04 : 1
        e.style.setProperty('--py', `${(-c * Number(e.dataset.dp) * k).toFixed(1)}px`)
      }
    }
    const on = () => { if (!raf) raf = requestAnimationFrame(tick) }
    window.addEventListener('scroll', on, { passive: true })
    tick()
    return () => {
      window.removeEventListener('scroll', on)
      cancelAnimationFrame(raf)
    }
  }, [reduced])

  // Pause SMIL route dots while the tab is hidden.
  useEffect(() => {
    const el = root.current
    if (!el) return
    const on = () => el.querySelectorAll('svg').forEach((v) => (document.hidden ? v.pauseAnimations() : v.unpauseAnimations()))
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [])

  return (
    <main ref={root} className={`${s.page} ${armed ? s.armed : ''}`} style={{ ...colorVars, '--c-usdc': usdcBlue } as CSSProperties}>
      <Hero reduced={reduced} />

      <section className={s.sec} id="feed" style={{ '--c': colors.primary } as CSSProperties}>
        <Words word="Feed" echo className={s.feedWords} />
        <Tl d={{ x: 24, y: 22, w: 340, r: -5, dp: 0.25 }} m={{ x: 35, y: 17, w: 270, r: -5 }} node="dm">
          <StoryCard tag="Why it moved" title="Jupiter volume jumps 40% after new perps launch" body="Traders moved fast. Here is the short version." why={['JUP', 'Perps']} />
        </Tl>
        <Tl d={{ x: 78, y: 18, w: 320, r: 4, dp: 0.15 }} dOnly><Shot k="oneinch" /></Tl>
        <Tl d={{ x: 72, y: 72, w: 360, r: -4, dp: 0.3 }} m={{ x: 62, y: 73, w: 280, r: 4 }}><Shot k="cal" /></Tl>
        <Tl d={{ x: 20, y: 74, w: 300, r: 5, dp: 0.1 }} dOnly>
          <StoryCard icon="◷" tag="What’s next" title="Fed rate call · Wed" body="Prediction markets price a hold." />
        </Tl>
      </section>

      <section className={`${s.sec} ${s.apps}`} id="apps" style={{ '--c': colors.viridian } as CSSProperties}>
        <Words word="Apps" className={s.appsWords} />
        <div className={s.burst} aria-hidden />
        <svg className={`${s.arcs} ${s.arcsD}`} viewBox="0 0 1440 900" preserveAspectRatio="none" aria-hidden>
          <path d="M20 740 C150 700 210 610 274 567 S330 390 346 342 S520 70 700 30" />
          <path d="M446 540 C620 680 760 700 878 648 S1250 560 1420 520" />
          <path d="M1022 252 C1150 170 1250 230 1267 360 S1320 700 1400 860" />
          <rect x="17" y="737" width="6" height="6" /><rect x="697" y="27" width="6" height="6" /><rect x="1417" y="517" width="6" height="6" /><rect x="1397" y="857" width="6" height="6" />
        </svg>
        <svg className={`${s.arcs} ${s.arcsM}`} viewBox="0 0 390 620" preserveAspectRatio="none" aria-hidden>
          <path d="M8 470 C50 410 60 310 86 250 S180 90 260 52" />
          <path d="M137 330 C170 383 200 368 222 347 S330 346 384 346" />
          <path d="M300 205 C340 177 360 147 380 88" />
          <rect x="5" y="467" width="6" height="6" /><rect x="257" y="49" width="6" height="6" /><rect x="381" y="343" width="6" height="6" /><rect x="377" y="85" width="6" height="6" />
        </svg>
        <ul className={s.glass} aria-label="Apps you can act on">
          {appTiles.map((a) => (
            <li
              key={a.name}
              className={`${s.gt} ${a.m ? '' : s.dOnly}`}
              tabIndex={0}
              data-n={`${a.name} · ${a.kind}`}
              data-dp={a.dp}
              data-node={a.node ? '' : undefined}
              style={place(a.d, a.m)}
            >
              <Image src={a.logo} alt={a.name} width={40} height={40} unoptimized />
            </li>
          ))}
        </ul>
      </section>

      <section className={`${s.sec} ${s.wallet}`} id="wallet" style={{ '--c': colors.accent } as CSSProperties}>
        <Words word="Wallet" echo className={s.walletWords} />
        <Tl d={{ x: 16, y: 34, w: 300, r: -4, dp: 0.25 }} m={{ x: 50, y: 18, w: 300, r: -3 }} node="m"><PortfolioCard /></Tl>
        <Tl d={{ x: 85, y: 66, w: 290, r: 4, dp: 0.2 }} m={{ x: 50, y: 73, w: 300, r: 3 }} node="d"><MoveCard /></Tl>
        <p className={s.line}><b>Understand the market and act in the same app.</b></p>
      </section>

      <section className={s.end} id="try">
        <h2>
          Available on the<br />
          <span>Solana dApp Store.</span>
        </h2>
        <Ctas />
      </section>

      <svg className={s.pagePath} height={gp.h} style={{ height: gp.h }} aria-hidden>
        <path d={gp.g1} stroke={colors.primary} {...DOTTED} />
        <path d={gp.g2} stroke={colors.viridian} {...DOTTED} />
        {gp.all && !reduced && (
          <circle className={s.dot} r={5} fill={colors.accent}>
            <animateMotion dur="14s" repeatCount="indefinite" path={gp.all} />
          </circle>
        )}
      </svg>

      <footer className={s.footer}>
        <span>© 2026 MyBoon · Example data shown · Not financial advice.</span>
        <a href={X_URL}>X @myboonapp</a>
        <a href="#telegram">Telegram (soon)</a>
        <span>Docs, coming soon</span>
        <PolicyLinks />
      </footer>
    </main>
  )
}
