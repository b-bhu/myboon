import Link from 'next/link'
import { Icon } from './icons'

const TABS = [{ id: 'feed', href: '/wallet/feed', label: 'Feed' }, { id: 'apps', href: '/wallet/apps', label: 'Apps' }, { id: 'wallet', href: '/wallet', label: 'Wallet' }] as const

export function PhoneShell({ tab, children }: { tab: 'feed' | 'apps' | 'wallet'; children: React.ReactNode }) {
  return (
    <div className="wm presentation" data-tab={tab}>
      <div className="wm-stage">
      <aside className="wm-side l" aria-label="The problem"><h2>The problem</h2><ul><li>Moving money between apps and chains meant thinking about internal wallets.</li><li>Every move was several steps: withdraw, bridge, deposit.</li><li>The screen showed details people don&apos;t care about.</li></ul></aside>
      <section className="phone" aria-label="MyBoon app mock">
        <div className="app-content">
          <div className="wm-pill" aria-hidden="true"><span>Mock design · MyBoon app</span></div>
          <header className="masthead">
            <span className="wordmark" role="img" aria-label="MyBoon" />
            <div className="header-actions"><span className="icon-button" aria-hidden="true"><Icon name="bell" /></span><span className="profile-button" aria-hidden="true"><span className="avatar">b</span></span></div>
          </header>
          {children}
          <nav className="nav" aria-label="Main navigation">
            {TABS.map((t) => (
              <Link key={t.id} href={t.href} scroll={false} aria-current={t.id === tab ? 'page' : undefined}><Icon name={t.id} />{t.label}</Link>
            ))}
          </nav>
        </div>
      </section>
      <aside className="wm-side r" aria-label="The approach"><h2>The approach</h2><ul><li>Show only apps and chains, joined by one connected route.</li><li>Pick a token on each side, then swipe to confirm with live status on the slider.</li><li>No approval counts and no internal wallet on screen.</li></ul></aside>
      </div>
      <footer className="wm-foot">Example data · <a href="/">myboon.tech</a></footer>
    </div>
  )
}
