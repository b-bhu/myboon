import type { Metadata } from 'next'
import PolicyPage from '@/components/policy/PolicyPage'
import { SUPPORT_EMAIL } from '@/components/policy/PolicyLinks'

export const metadata: Metadata = {
  title: 'Delete your account · MyBoon',
  description: 'How to delete your MyBoon account and data.',
  alternates: { canonical: '/delete-account' },
}

const mailto = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('Delete my MyBoon account')}`

export default function DeleteAccount() {
  return (
    <PolicyPage kicker="Account" title="Delete your account" updated="23 October 2026"
      lede="You can ask us to delete your MyBoon account at any time. Here’s how, and what happens to your wallet and data.">
      <h2>Before you start: move your funds</h2>
      <p>Deleting your account removes access to its embedded wallet through MyBoon. <b>Send any tokens you want to keep to another wallet first.</b> We can’t recover funds after deletion, because we never hold your keys.</p>

      <h2>How to request deletion</h2>
      <ol>
        <li>Move your funds out, as above.</li>
        <li>Email <a href={mailto}>{SUPPORT_EMAIL}</a> from the address you sign in with, with the subject “Delete my MyBoon account”. If you sign in with Google, use that Google address.</li>
        <li>We’ll confirm the request by email and delete your account within 30 days.</li>
      </ol>
      <p>You can sign out at any time from your profile settings, but signing out alone doesn’t delete your account.</p>

      <h2>What gets deleted</h2>
      <ul>
        <li>Your MyBoon account and your Privy login (email or Google link).</li>
        <li>The link between your account and its wallet addresses.</li>
      </ul>

      <h2>What stays</h2>
      <ul>
        <li>Blockchain transactions. They are public and permanent, and nobody can delete them.</li>
        <li>Data held by apps you used, such as Polymarket, Jupiter, Phoenix, Pacifica or Meteora, under their own policies.</li>
        <li>Settings stored on your phone, until you uninstall the app or clear its data.</li>
      </ul>
    </PolicyPage>
  )
}
