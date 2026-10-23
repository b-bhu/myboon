import type { Metadata } from 'next'
import { headers } from 'next/headers'
import QRCode from 'qrcode'
import { colors } from '@/lib/tokens'
import Downloads from '@/components/downloads/Downloads'
import { STORE_URL, variantFromUA } from '@/components/downloads/ua'

const title = 'Get MyBoon on the Solana dApp Store'
const description = 'Install MyBoon on Seeker or any Solana Mobile phone from the Solana dApp Store.'

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: '/downloads' },
  openGraph: { url: '/downloads', title, description, images: [{ url: '/landing/og.png', width: 1200, height: 630, alt: title }] },
  twitter: { card: 'summary_large_image', site: '@myboonapp', title, description, images: ['/landing/og.png'] },
}

export default async function DownloadsPage() {
  const ua = (await headers()).get('user-agent')
  const qrSvg = await QRCode.toString(STORE_URL, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 0,
    color: { dark: colors.walletCore, light: colors.bone },
  })
  return <Downloads variant={variantFromUA(ua)} qrSvg={qrSvg} />
}
