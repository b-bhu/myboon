import type { Metadata } from 'next'
import PolicyPage, { policyStyles as s } from '@/components/policy/PolicyPage'
import { SUPPORT_EMAIL } from '@/components/policy/PolicyLinks'

export const metadata: Metadata = {
  title: 'Privacy Policy · MyBoon',
  description: 'What the MyBoon app collects, who it shares data with, and how to delete your account.',
  alternates: { canonical: '/privacy' },
}

export default function Privacy() {
  return (
    <PolicyPage kicker="Privacy" title="Privacy Policy" updated="23 October 2026"
      lede="MyBoon explains market moves and lets you act on them from a self-custodial wallet. This page covers what the app collects, who it shares data with, and the choices you have.">
      <div className={s.callout}>
        <p><b>Your keys stay yours.</b> Wallets in MyBoon are created and held by Privy, our wallet provider. MyBoon never sees, stores or can recover your private keys or seed phrase.</p>
      </div>

      <h2>What we collect</h2>
      <ul>
        <li><b>Sign-in details.</b> When you sign in with email or Google, Privy handles the sign-in and gives MyBoon an account ID, your login method and your email address.</li>
        <li><b>Public wallet addresses.</b> The Solana and EVM addresses linked to your account, and any external Solana wallet you connect. These are public on the blockchain.</li>
        <li><b>App requests.</b> To show stories, prices and balances, the app sends requests to our API at api.myboon.tech, which include the wallet addresses and markets being looked up. Each request also carries a random session ID that resets when the app restarts. We use it only to limit abuse, and it is not tied to your identity.</li>
        <li><b>Settings on your device.</b> Preferences such as your odds format and which networks you have turned on are stored on your phone, not on our servers.</li>
      </ul>

      <h2>What we don’t collect</h2>
      <ul>
        <li>Private keys or seed phrases.</li>
        <li>Your contacts, photos, location or microphone.</li>
        <li>Advertising IDs. The app contains no ad SDKs and no third-party analytics SDKs.</li>
      </ul>
      <p>The app does not currently send push notifications.</p>

      <h2>Who we share data with</h2>
      <p>We don’t sell your data. To make the app work, some data goes to these services:</p>
      <ul>
        <li><b>Privy</b>: sign-in and embedded wallets.</li>
        <li><b>Google</b>: only if you choose Google sign-in.</li>
        <li><b>Blockchain networks and RPC providers</b> (Solana, Polygon): to read balances and send the transactions you approve. Transactions are public and permanent.</li>
        <li><b>Apps you choose to use</b>: Jupiter, Phoenix, Pacifica, Meteora and Polymarket receive your wallet address and the orders or swaps you submit. Their own terms and privacy policies apply.</li>
      </ul>

      <h2>How long we keep it</h2>
      <p>We keep your account details while your account is active. You can ask us to delete your account at any time; see <a href="/delete-account">Delete your account</a>. Records already written to a blockchain can’t be deleted by anyone.</p>

      <h2>Your choices</h2>
      <ul>
        <li>Sign out at any time from your profile settings in the app.</li>
        <li>Ask for a copy of your data, a correction, or deletion by emailing <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.</li>
      </ul>

      <h2>Children</h2>
      <p>MyBoon is not meant for anyone under 18.</p>

      <h2>Changes</h2>
      <p>If this policy changes, we’ll update this page and the date below.</p>

      <h2>Contact</h2>
      <p>Questions about privacy: <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.</p>
    </PolicyPage>
  )
}
