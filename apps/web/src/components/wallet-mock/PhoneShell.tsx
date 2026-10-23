import Link from 'next/link'
import { Icon } from './icons'

const TABS = [{ id: 'feed', href: '/wallet/feed', label: 'Feed' }, { id: 'apps', href: '/wallet/apps', label: 'Apps' }, { id: 'wallet', href: '/wallet', label: 'Wallet' }] as const

export function PhoneShell({ tab, children }: { tab: 'feed' | 'apps' | 'wallet'; children: React.ReactNode }) {
  return (
    <div className="wm presentation">
      <section className="phone" aria-label="MyBoon app mock">
        <div className="app-content">
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
      <footer className="wm-foot">Example data · <a href="/">myboon.tech</a></footer>
    </div>
  )
}
