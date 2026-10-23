'use client'

import Image from 'next/image'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { colors, colorVars, type ColorToken } from '@/lib/tokens'
import { apps, crops, heroTiles, sectionTiles, X_URL, type SecTile, type TileKey } from './data'
import s from './landing.module.css'

const MOBILE_BP = 600
const useIso = typeof window === 'undefined' ? useEffect : useLayoutEffect

/** Client-only breakpoint read; layout itself switches in CSS so SSR markup never changes. */
const isMobile = () => window.matchMedia(`(max-width: ${MOBILE_BP - 1}px)`).matches

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

type Pt = [number, number]
/** Smooth cubic path through points; horizontal or vertical easing. */
function curve(pts: Pt[], axis: 'x' | 'y') {
  if (!pts.length) return ''
  let d = `M${pts[0][0]},${pts[0][1]}`
  for (let i = 1; i < pts.length; i++) {
    const [px, py] = pts[i - 1]
    const [qx, qy] = pts[i]
    if (axis === 'x') {
      const mx = (px + qx) / 2
      d += ` C${mx},${py} ${mx},${qy} ${qx},${qy}`
    } else {
      const my = (py + qy) / 2
      d += ` C${px},${my} ${qx},${my} ${qx},${qy}`
    }
  }
  return d
}

/** Giant word stack (echo / main / echo) sized to a share of the container width. */
function Words({ words, ratio, cap, color, className }: { words: [string, string, string]; ratio: [number, number]; cap: [number, number]; color: ColorToken; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const mainRef = useRef<HTMLSpanElement>(null)
  useIso(() => {
    const el = ref.current
    const main = mainRef.current
    if (!el || !main) return
    const fit = () => {
      const m = isMobile() ? 1 : 0
      el.style.setProperty('--fs', '100px')
      const mw = main.getBoundingClientRect().width
      const W = el.parentElement?.clientWidth ?? window.innerWidth
      if (mw) el.style.setProperty('--fs', `${Math.min((100 * W * ratio[m]) / mw, cap[m])}px`)
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el.parentElement ?? el)
    document.fonts?.ready.then(fit)
    return () => ro.disconnect()
  }, [ratio[0], ratio[1], cap[0], cap[1]])
  return (
    <div ref={ref} aria-hidden className={`${s.words} ${className ?? ''}`} style={{ '--fs': `${cap[0] * 0.6}px`, '--wc': colors[color] } as CSSProperties}>
      <span className={`${s.w} ${s.echo} ${s.echoB}`}>{words[0]}</span>
      <span ref={mainRef} className={`${s.w} ${s.main}`}>{words[1]}</span>
      <span className={`${s.w} ${s.echo} ${s.echoA}`}>{words[2]}</span>
    </div>
  )
}

function TileBody({ k, w, priority }: { k: TileKey; w: number; priority?: boolean }) {
  if (k in apps) {
    const a = apps[k as keyof typeof apps]
    return (
      <div className={`${s.card} ${s.app}`} aria-hidden>
        <div className={s.mk}>
          <Image src={a.logo} alt="" width={30} height={30} unoptimized />
        </div>
        <div>
          <b>{a.name}</b>
          <span>{a.kind}</span>
        </div>
      </div>
    )
  }
  const c = crops[k as keyof typeof crops]
  return (
    <div className={s.card}>
      <Image src={c.src} alt={c.alt} width={c.w} height={c.h} sizes={`${w}px`} priority={priority} />
    </div>
  )
}

function Hero() {
  const ref = useRef<HTMLElement>(null)
  const [paths, setPaths] = useState({ p1: '', p2: '', all: '' })

  useIso(() => {
    const h = ref.current
    if (!h) return
    const build = () => {
      const tiles = isMobile() ? heroTiles.m : heroTiles.d
      const W = h.clientWidth
      const H = h.clientHeight
      const pts = tiles.filter((t) => t.seg !== 'n').map((t) => [(t.x * W) / 100, (t.y * H) / 100, t.seg] as const)
      const b: Pt[] = pts.filter((p) => p[2] === 'b').map(([x, y]) => [x, y])
      const g: Pt[] = [b[b.length - 1], ...pts.filter((p) => p[2] === 'g').map(([x, y]) => [x, y] as Pt)]
      const pre: Pt = [-40, pts[0][1] - 60]
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
      </nav>
      <Words words={['Understand.', 'Understand.', 'Act.']} ratio={[0.9, 0.94]} cap={[300, 300]} color="accent" />
      <svg className={s.path} aria-hidden>
        <path d={paths.p1} fill="none" stroke={colors.primary} strokeWidth={2.2} strokeDasharray="1 7" strokeLinecap="round" />
        <path d={paths.p2} fill="none" stroke={colors.viridian} strokeWidth={2.2} strokeDasharray="1 7" strokeLinecap="round" />
        {paths.all && (
          <circle className={s.dot} r={4.5} fill={colors.viridian}>
            <animateMotion dur="7s" repeatCount="indefinite" rotate="auto" path={paths.all} />
          </circle>
        )}
      </svg>
      {(['d', 'm'] as const).flatMap((v) => heroTiles[v].map((t, i) => (
        <div
          key={`${v}-${t.k}-${i}`}
          className={`${s.tile} ${v === 'd' ? s.dOnly : s.mOnly}`}
          style={{ left: `${t.x}%`, top: `${t.y}%`, width: t.w, '--r': `${t.r}deg`, '--d': `${5 + i * 0.7}s`, animationDelay: `-${i * 1.3}s` } as CSSProperties}
        >
          <TileBody k={t.k} w={t.w} priority={v === 'd'} />
        </div>
      )))}
      <div className={s.copy}>
        <h1>
          Understand markets.<br className={s.mob} /> Act in the same app.
        </h1>
        <p>Every market move explained as it happens, with the trade one tap away on Solana.</p>
        <a className={s.btn} href="/downloads">
          Join the beta
        </a>
      </div>
    </section>
  )
}

function Showcase({ id, word, color, line, tiles }: { id: string; word: string; color: ColorToken; line: ReactNode; tiles: { d: SecTile[]; m: SecTile[] } }) {
  return (
    <section className={s.sec} id={id} aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className={s.srOnly}>{word}</h2>
      <Words words={[word, word, word]} ratio={[0.62, 0.8]} cap={[380, 200]} color={color} />
      {(['d', 'm'] as const).flatMap((v) => tiles[v].map((t, i) => (
        <div
          key={`${v}-${t.k}-${i}`}
          className={`${s.tl} ${v === 'd' ? s.dOnly : s.mOnly}`}
          data-dp={t.dp}
          data-ch={t.ch || undefined}
          style={{ left: `${t.x}%`, top: `${t.y}%`, width: t.w }}
        >
          <div className={s.in} style={{ '--r': `${t.r}deg` } as CSSProperties}>
            <TileBody k={t.k} w={t.w} />
          </div>
        </div>
      )))}
      <p className={s.line}>{line}</p>
    </section>
  )
}

export default function Landing() {
  const reduced = useReducedMotion()
  const root = useRef<HTMLElement>(null)
  const [gp, setGp] = useState({ h: 0, g1: '', g2: '', all: '' })

  const measure = useCallback(() => {
    const el = root.current
    if (!el) return
    const base = el.getBoundingClientRect()
    const chain = [...el.querySelectorAll<HTMLElement>('[data-ch]')].filter((e) => e.offsetParent !== null).sort((a, b) => Number(a.dataset.ch) - Number(b.dataset.ch))
    const pts: Pt[] = chain.map((e) => {
      const r = e.getBoundingClientRect()
      return [r.left - base.left + r.width / 2, r.top - base.top + r.height / 2]
    })
    const feed = el.querySelector<HTMLElement>('#feed')
    if (!feed || pts.length < 3) return
    pts.unshift([el.clientWidth * 0.08, feed.offsetTop + 40])
    setGp({ h: el.scrollHeight, g1: curve(pts.slice(0, 3), 'y'), g2: curve(pts.slice(2), 'y'), all: curve(pts, 'y') })
  }, [])

  // Tilt-in on enter, page path layout.
  useIso(() => {
    const el = root.current
    if (!el) return
    const tls = [...el.querySelectorAll<HTMLElement>(`.${s.tl}`)]
    let io: IntersectionObserver | undefined
    if (reduced || !('IntersectionObserver' in window)) {
      tls.forEach((t) => t.classList.add(s.on))
    } else {
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
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => {
      io?.disconnect()
      ro.disconnect()
    }
  }, [reduced, measure])

  // Light scroll parallax (transform only, rAF-throttled).
  useEffect(() => {
    if (reduced) return
    const el = root.current
    if (!el) return
    let raf = 0
    const tick = () => {
      raf = 0
      const vh = window.innerHeight
      el.querySelectorAll<HTMLElement>(`.${s.tl}`).forEach((e) => {
        const r = e.getBoundingClientRect()
        if (r.bottom < -200 || r.top > vh + 200) return
        const c = r.top + r.height / 2 - vh / 2
        ;(e.firstElementChild as HTMLElement).style.setProperty('--py', `${-c * Number(e.dataset.dp)}px`)
      })
    }
    const on = () => { if (!raf) raf = requestAnimationFrame(tick) }
    window.addEventListener('scroll', on, { passive: true })
    tick()
    return () => {
      window.removeEventListener('scroll', on)
      cancelAnimationFrame(raf)
    }
  }, [reduced])

  // Pause SMIL path dots while the tab is hidden.
  useEffect(() => {
    const el = root.current
    if (!el) return
    const on = () => el.querySelectorAll('svg').forEach((v) => (document.hidden ? v.pauseAnimations() : v.unpauseAnimations()))
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [])

  return (
    <main ref={root} className={s.page} style={colorVars as CSSProperties}>
      <Hero />
      <Showcase
        id="feed"
        word="Feed"
        color="primary"
        tiles={sectionTiles.feed}
        line={<><b>Stories</b> explain why it moved. <b>Updates</b> keep you current. <b>The calendar</b> shows what’s next.</>}
      />
      <Showcase
        id="apps"
        word="Apps"
        color="viridian"
        tiles={sectionTiles.apps}
        line={<>The best of Solana, one tap from the story. <b>Swap, perps, liquidity and predictions</b> in one app.</>}
      />
      <Showcase
        id="wallet"
        word="Wallet"
        color="accent"
        tiles={sectionTiles.wallet}
        line={<>Your own Solana wallet, built in. <b>Slide to swap</b> and you’re in the trade.</>}
      />
      <section className={s.end}>
        <h2>
          Understand markets.<br />
          <span>Act in the same app.</span>
        </h2>
        <a className={s.btn} href="/downloads">
          Join the beta
        </a>
      </section>
      <svg className={s.pagePath} height={gp.h} style={{ height: gp.h }} aria-hidden>
        <path d={gp.g1} fill="none" strokeWidth={2.2} strokeDasharray="1 7" strokeLinecap="round" stroke={colors.primary} />
        <path d={gp.g2} fill="none" strokeWidth={2.2} strokeDasharray="1 7" strokeLinecap="round" stroke={colors.viridian} />
        {gp.all && (
          <circle className={s.dot} r={5} fill={colors.accent}>
            <animateMotion dur="14s" repeatCount="indefinite" path={gp.all} />
          </circle>
        )}
      </svg>
      <footer className={s.footer}>
        <span>© 2026 MyBoon · Not financial advice.</span>
        <a href={X_URL} target="_blank" rel="noopener noreferrer" aria-label="Follow @myboonapp on X (opens in new tab)">Follow @myboonapp on X ↗</a>
      </footer>
    </main>
  )
}
