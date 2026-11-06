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
    <PolicyPage kicker="Privacy" title="Privacy Policy" updated="6 November 2026"
      lede="MyBoon sticks market context to the next action — understand why it moved, then act in the same app. This page covers what the app collects and the choices you have.">
      <div className={s.callout}>
        <p><b>Your keys, your funds.</b> MyBoon is non-custodial. We never hold your private keys, seed phrase or funds. You can read the feed without an account. If you connect a wallet, every transaction needs your approval.</p>
      </div>

      <h2>What we collect</h2>
      <ul>
        <li><b>App requests.</b> To load stories, updates, the calendar and market data, the app sends requests to our API at api.myboon.tech. Each request carries a random session ID that resets when the app restarts. We use it only to limit abuse, and it isn’t tied to your identity.</li>
        <li><b>Wallet connection.</b> You can connect your own Solana wallet, or sign in with email or Google to use an embedded Solana wallet. We see the public address so the app can show balances and prepare transactions you approve. Sign-in is handled by Privy, our embedded-wallet provider. We never receive your private keys or seed phrase.</li>
        <li><b>Settings on your device.</b> Preferences such as your odds format are stored on your phone, not on our servers.</li>
      </ul>

      <h2>What we don’t collect</h2>
      <ul>
        <li>Your contacts, photos, location or microphone.</li>
        <li>Advertising IDs. The app contains no ad SDKs and no third-party analytics SDKs.</li>
        <li>Private keys or seed phrases. MyBoon cannot move funds without a transaction you approve.</li>
      </ul>
      <p>The app does not send push notifications.</p>

      <h2>Who we share data with</h2>
      <p>We don’t sell your data. Market data shown in the app comes from public sources. Swaps are routed through Jupiter. Opening a third-party app takes you to that app, whose own terms and privacy policy apply. If you sign in for an embedded wallet, Privy processes the email or Google identity you use.</p>

      <h2>How long we keep it</h2>
      <p>The session ID is not an account and resets when the app restarts. Settings on your phone stay until you clear them. A sign-in lasts while that account exists. Transactions you approve stay on the blockchain, and we can’t delete them. To ask us to delete data we hold, see <a href="/delete-account">Delete your data</a>.</p>

      <h2>Your choices</h2>
      <p>You can use MyBoon without connecting a wallet. You can disconnect a wallet in the app. You can ask for a copy of your data, a correction, or deletion by emailing <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.</p>

      <h2>Children</h2>
      <p>MyBoon is not meant for anyone under 18.</p>

      <h2>Changes</h2>
      <p>When we change what we collect, we’ll update this policy and change the date below.</p>

      <h2>Contact</h2>
      <p>Questions about privacy: <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.</p>
    </PolicyPage>
  )
}
