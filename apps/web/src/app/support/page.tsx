import type { Metadata } from 'next'
import PolicyPage from '@/components/policy/PolicyPage'
import { SUPPORT_EMAIL } from '@/components/policy/PolicyLinks'
import { X_URL } from '@/components/landing/data'

export const metadata: Metadata = {
  title: 'Support · MyBoon',
  description: 'Get help with the MyBoon app.',
  alternates: { canonical: '/support' },
}

export default function Support() {
  return (
    <PolicyPage kicker="Support" title="Get help" updated="23 October 2026"
      lede="Stuck on something in MyBoon? Here’s how to reach us and fix the common issues yourself.">
      <h2>Contact us</h2>
      <ul>
        <li>Email <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>. Tell us your phone model, app version and what happened.</li>
        <li>Message <a href={X_URL} target="_blank" rel="noopener noreferrer">@myboonapp on X</a>.</li>
      </ul>
      <p><b>We will never ask for your seed phrase or private key.</b> Anyone who does is not MyBoon.</p>

      <h2>Common fixes</h2>
      <ul>
        <li><b>Can’t sign in:</b> check the email code hasn’t expired and request a new one, or try Google sign-in.</li>
        <li><b>Balance looks wrong:</b> on-chain balances can take a few seconds to update. Close and reopen the wallet to refresh it.</li>
        <li><b>A swap or trade failed:</b> check you have enough SOL for network fees, then try again. Failed transactions don’t move your funds apart from any network fee.</li>
        <li><b>Sign out:</b> open your profile, tap the settings icon, then tap Sign out.</li>
      </ul>

      <h2>Your account</h2>
      <p>To delete your account and data, see <a href="/delete-account">Delete your account</a>. Our <a href="/privacy">Privacy Policy</a> explains what we collect.</p>
    </PolicyPage>
  )
}
