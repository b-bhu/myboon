import Image from 'next/image'
import type { CSSProperties, ReactNode } from 'react'
import { colorVars } from '@/lib/tokens'
import l from '@/components/landing/landing.module.css'
import s from './policy.module.css'
import { PolicyLinks } from './PolicyLinks'

export default function PolicyPage({ kicker, title, lede, updated, children }: { kicker: string; title: string; lede: ReactNode; updated: string; children: ReactNode }) {
  return (
    <main className={s.page} style={colorVars as CSSProperties}>
      <nav className={s.nav}>
        <a href="/" aria-label="MyBoon home">
          <Image src="/branding/myboon-wordmark-header.png" alt="MyBoon" width={420} height={218} priority />
        </a>
      </nav>
      <article className={s.body}>
        <div className={s.kicker}>{kicker}</div>
        <h1>{title}</h1>
        <p className={s.lede}>{lede}</p>
        {children}
        <p className={s.meta}>Last updated {updated}</p>
      </article>
      <footer className={l.footer}>
        <span>© 2026 MyBoon</span>
        <a href="/downloads">Get MyBoon</a>
        <PolicyLinks />
      </footer>
    </main>
  )
}
export { s as policyStyles }
