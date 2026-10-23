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
        <li>Email <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>. Tell us your phone model, the app version and what happened.</li>
        <li>Message <a href={X_URL} target="_blank" rel="noopener noreferrer">@myboonapp on X</a>.</li>
      </ul>
      <p><b>We will never ask for your seed phrase or private key.</b> Anyone who does is not MyBoon.</p>

      <h2>Common fixes</h2>
      <ul>
        <li><b>Stories or updates won’t load:</b> check your connection, then close and reopen the app.</li>
        <li><b>Prices look out of date:</b> market data can lag by a few seconds. Reopen the screen to refresh it.</li>
        <li><b>Waitlist:</b> to change or remove your waitlist email, email us.</li>
      </ul>

      <h2>Your data</h2>
      <p>To delete your data, see <a href="/delete-account">Delete your data</a>. Our <a href="/privacy">Privacy Policy</a> explains what we collect.</p>
    </PolicyPage>
  )
}
