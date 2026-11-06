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
    <PolicyPage kicker="Account" title="Delete your data" updated="6 November 2026"
      lede="MyBoon sticks market context to the next action — understand why it moved, then act in the same app. You can read the feed without an account. If you signed in or connected a wallet, here’s what you can remove.">
      <h2>If you signed in</h2>
      <ol>
        <li>Email <a href={mailto}>{SUPPORT_EMAIL}</a> from the address you used, with the subject “Delete my MyBoon data”.</li>
        <li>We’ll delete the account data we hold and confirm by email within 30 days.</li>
      </ol>
      <p>Signing in with email or Google can create an embedded Solana wallet so you can act in the app. MyBoon is non-custodial: we never hold your private keys or your funds. Deleting your MyBoon data does not move funds, and transactions already on the blockchain can’t be reversed.</p>

      <h2>If you connected your own wallet</h2>
      <p>That wallet stays in the wallet app you connected. Disconnect it in MyBoon. We never have its keys. Email us if you also want us to delete connection data we hold.</p>

      <h2>Data on your phone</h2>
      <p>Settings such as your odds format stay on your phone. Uninstall the app, or clear its data in Android settings, to remove them.</p>
    </PolicyPage>
  )
}
