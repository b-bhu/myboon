import type { Metadata } from 'next'
import './wallet.css'

export const metadata: Metadata = {
  title: 'MyBoon Wallet: try Move and Swap (example data)',
  description: 'A clickable mock of the MyBoon Wallet. Move funds between apps and chains, swap, send and receive. Example data only.',
}

export default function WalletLayout({ children }: { children: React.ReactNode }) {
  return children
}
