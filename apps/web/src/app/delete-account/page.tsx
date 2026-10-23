import type { Metadata } from 'next'
import PolicyPage from '@/components/policy/PolicyPage'
import { SUPPORT_EMAIL } from '@/components/policy/PolicyLinks'

export const metadata: Metadata = {
  title: 'Delete your data · MyBoon',
  description: 'How to delete your MyBoon data.',
  alternates: { canonical: '/delete-account' },
}

const mailto = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('Delete my MyBoon data')}`

export default function DeleteAccount() {
  return (
    <PolicyPage kicker="Account" title="Delete your data" updated="23 October 2026"
      lede="The current version of MyBoon is read-only. You don’t need an account to use it, so there’s very little to delete.">
      <h2>If you joined the waitlist</h2>
      <ol>
        <li>Email <a href={mailto}>{SUPPORT_EMAIL}</a> from the address you signed up with, with the subject “Delete my MyBoon data”.</li>
        <li>We’ll remove your email from the waitlist and confirm by email within 30 days.</li>
      </ol>

      <h2>Data on your phone</h2>
      <p>Settings such as your odds format stay on your phone. Uninstall the app, or clear its data in Android settings, to remove them.</p>

      <h2>Anything else</h2>
      <p>The app doesn’t create accounts or wallets, so there’s nothing else to delete. If that changes in a future version, this page will explain how to delete them.</p>
    </PolicyPage>
  )
}
