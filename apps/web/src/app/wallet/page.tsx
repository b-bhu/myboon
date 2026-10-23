import { Suspense } from 'react'
import { PhoneShell } from '@/components/wallet-mock/PhoneShell'
import { WalletScreen } from '@/components/wallet-mock/WalletScreen'

export default function WalletPage() {
  return <PhoneShell tab="wallet"><Suspense><WalletScreen /></Suspense></PhoneShell>
}
