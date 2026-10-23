import type { Metadata } from 'next'
import PolicyPage, { policyStyles as s } from '@/components/policy/PolicyPage'
import { SUPPORT_EMAIL } from '@/components/policy/PolicyLinks'

export const metadata: Metadata = {
  title: 'Terms of Use · MyBoon',
  description: 'The terms for using the MyBoon app and website.',
  alternates: { canonical: '/terms' },
}

export default function Terms() {
  return (
    <PolicyPage kicker="Terms" title="Terms of Use" updated="23 October 2026"
      lede="MyBoon is a crypto and market news feed with a wallet on Solana. By using the MyBoon app or website, you agree to these terms.">
      <div className={s.callout}>
        <p><b>Your keys, your funds.</b> MyBoon is non-custodial. We never hold your private keys or your funds, and every transaction needs your approval.</p>
      </div>

      <h2>Using MyBoon</h2>
      <p>The app is free. You can read the feed without an account. Content in MyBoon is for information only.</p>

      <h2>Your wallet</h2>
      <ul>
        <li>You may connect your own Solana wallet. You are responsible for keeping it, its keys and its recovery phrase safe.</li>
        <li>Swaps are routed through Jupiter. You review and approve every transaction yourself, and transactions on a blockchain can’t be reversed.</li>
      </ul>

      <h2>Third-party apps</h2>
      <p>MyBoon lets you act in third-party apps such as Polymarket, Pacifica, Phoenix and Meteora. Those apps are run by others and have their own terms. MyBoon isn’t responsible for them.</p>

      <h2>Acceptable use</h2>
      <p>Don’t misuse MyBoon. That includes breaking the law, interfering with or overloading our services, trying to access systems or data you aren’t allowed to, or scraping the app at scale.</p>

      <h2>No warranties</h2>
      <p>MyBoon is provided “as is” and “as available”. We don’t promise that it will be error-free, uninterrupted, or that its content is complete, accurate or up to date.</p>

      <h2>Limitation of liability</h2>
      <p>To the extent the law allows, MyBoon is not liable for any loss arising from your use of the app, including losses from transactions you approve, third-party apps, market movements or service outages.</p>

      <h2>Changes</h2>
      <p>We may update these terms. When we do, we’ll change the date below. If you keep using MyBoon after a change, you accept the updated terms.</p>

      <h2>Contact</h2>
      <p>Questions about these terms: <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.</p>
    </PolicyPage>
  )
}
