import type { Metadata } from 'next'
import PolicyPage, { policyStyles as s } from '@/components/policy/PolicyPage'
import { SUPPORT_EMAIL } from '@/components/policy/PolicyLinks'

export const metadata: Metadata = {
  title: 'Privacy Policy · MyBoon',
  description: 'What the MyBoon app collects, who it shares data with, and your choices.',
  alternates: { canonical: '/privacy' },
}

export default function Privacy() {
  return (
    <PolicyPage kicker="Privacy" title="Privacy Policy" updated="23 October 2026"
      lede="MyBoon explains what’s moving markets: developing stories, the latest updates and a market calendar, plus a directory of apps to explore. This page covers what the app collects and the choices you have.">
      <div className={s.callout}>
        <p><b>No account needed to read.</b> The current version of MyBoon is read-only. It has no wallet, can’t sign transactions and doesn’t hold funds.</p>
      </div>

      <h2>What we collect</h2>
      <ul>
        <li><b>App requests.</b> To load stories, updates, the calendar and market data, the app sends requests to our API at api.myboon.tech. Each request carries a random session ID that resets when the app restarts. We use it only to limit abuse, and it isn’t tied to your identity.</li>
        <li><b>Waitlist email.</b> If you join the waitlist for upcoming features, we collect the email address you enter, and use it only to tell you when those features are ready.</li>
        <li><b>Settings on your device.</b> Preferences such as your odds format are stored on your phone, not on our servers.</li>
      </ul>

      <h2>What we don’t collect</h2>
      <ul>
        <li>Your contacts, photos, location or microphone.</li>
        <li>Advertising IDs. The app contains no ad SDKs and no third-party analytics SDKs.</li>
        <li>Wallets, private keys or seed phrases. This version has no wallet.</li>
      </ul>
      <p>The app does not send push notifications.</p>

      <h2>Who we share data with</h2>
      <p>We don’t sell your data. Market data shown in the app comes from public sources, and opening an app from the Apps tab takes you to that app, whose own terms and privacy policy apply.</p>

      <h2>How long we keep it</h2>
      <p>We keep waitlist emails until the feature launches or you ask us to remove yours. To remove it, see <a href="/delete-account">Delete your data</a>.</p>

      <h2>Your choices</h2>
      <p>You can ask for a copy of your data, a correction, or deletion by emailing <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.</p>

      <h2>Children</h2>
      <p>MyBoon is not meant for anyone under 18.</p>

      <h2>Changes</h2>
      <p>When we add features such as a wallet, we’ll update this policy before they go live, and change the date below.</p>

      <h2>Contact</h2>
      <p>Questions about privacy: <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.</p>
    </PolicyPage>
  )
}
