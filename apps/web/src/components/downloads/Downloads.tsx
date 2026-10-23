import Image from 'next/image'
import type { CSSProperties } from 'react'
import { colors, colorVars } from '@/lib/tokens'
import { X_URL } from '@/components/landing/data'
import l from '@/components/landing/landing.module.css'
import s from './downloads.module.css'
import VariantGuard from './VariantGuard'
import { STORE_URL, type Variant } from './ua'

function Words({ word }: { word: string }) {
  return (
    <div aria-hidden className={s.words} style={{ '--wc': colors.accent } as CSSProperties}>
      <span className={`${l.w} ${l.echo} ${l.echoB}`}>{word}</span>
      <span className={`${l.w} ${l.main}`}>{word}</span>
      <span className={`${l.w} ${l.echo} ${l.echoA}`}>{word}</span>
    </div>
  )
}

function Desktop({ qrSvg }: { qrSvg: string }) {
  return (
    <>
      <Words word="Get it." />
      <div className={s.qrRow}>
        <div className={s.qrCard} role="img" aria-label="QR code: open MyBoon in the Solana dApp Store" dangerouslySetInnerHTML={{ __html: qrSvg }} />
        <div className={s.qt}>
          <h1>Scan with your Seeker.</h1>
          <p>MyBoon lives in the Solana dApp Store. Point the camera of a Seeker or any Solana Mobile phone at this code.</p>
          <ol>
            <li><b>Open the camera</b> on your Solana Mobile phone</li>
            <li><b>Scan the code</b> and tap the link</li>
            <li><b>Install</b> from the dApp Store</li>
          </ol>
          <span className={s.lnk}>{STORE_URL}</span>
        </div>
      </div>
    </>
  )
}

function Android() {
  return (
    <>
      <Words word="Get it." />
      <div className={s.mt}>
        <h1>MyBoon for Solana Mobile.</h1>
        <p>Every market move explained, with the trade one tap away.</p>
        <a className={`${l.btn} ${s.btn}`} href={STORE_URL}>Open in dApp Store</a>
        <p className={s.sub}>Opens the Solana dApp Store on Seeker and Saga.</p>
      </div>
    </>
  )
}

function Ios() {
  return (
    <>
      <Words word="Soon." />
      <div className={s.mt}>
        <h1>MyBoon is on Android (Solana Mobile) for now.</h1>
        <p>
          There’s no iPhone app yet.{' '}
          <a className={s.x} href={X_URL} target="_blank" rel="noopener noreferrer">Follow @myboonapp on X</a> to hear when that changes.
        </p>
      </div>
    </>
  )
}

export default function Downloads({ variant, qrSvg }: { variant: Variant; qrSvg: string }) {
  return (
    <main className={s.page} style={colorVars as CSSProperties} data-variant={variant}>
      <nav className={s.nav}>
        <a href="/" aria-label="MyBoon home">
          <Image src="/branding/myboon-wordmark-header.png" alt="MyBoon" width={420} height={218} priority />
        </a>
      </nav>
      <div className={s.body}>
        <VariantGuard initial={variant} views={{ desktop: <Desktop qrSvg={qrSvg} />, android: <Android />, ios: <Ios /> }} />
      </div>
      <footer className={l.footer}>
        <span>© 2026 MyBoon</span>
        <a href={X_URL} target="_blank" rel="noopener noreferrer" aria-label="Follow @myboonapp on X (opens in new tab)">Follow @myboonapp on X ↗</a>
      </footer>
    </main>
  )
}
