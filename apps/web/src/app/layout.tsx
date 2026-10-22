import type { Metadata, Viewport } from 'next'
import { Space_Grotesk, Inter, Geist_Mono } from 'next/font/google'
import './globals.css'

const spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  variable: '--font-headline',
  weight: ['300', '400', '500', '700'],
})

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-body',
  weight: ['400', '500', '600'],
})

const geistMono = Geist_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  weight: ['400', '500'],
})

export const metadata: Metadata = {
  metadataBase: new URL('https://myboon.tech'),
  title: 'MyBoon: Understand markets. Act in the same app.',
  description:
    'MyBoon tells you why the market moved and lets you act on it in the same app: researched stories, Solana apps and your own wallet.',
  openGraph: {
    type: 'website',
    siteName: 'MyBoon',
    url: '/',
    title: 'MyBoon: Understand markets. Act in the same app.',
    description: 'Every market move explained as it happens, with the trade one tap away on Solana.',
    images: [{ url: '/landing/og.png', width: 1200, height: 630, alt: 'MyBoon: Understand markets. Act in the same app.' }],
  },
  twitter: {
    card: 'summary_large_image',
    site: '@myboonapp',
    title: 'MyBoon: Understand markets. Act in the same app.',
    description: 'Every market move explained as it happens, with the trade one tap away on Solana.',
    images: ['/landing/og.png'],
  },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className="dark">
      <body
        className={`${spaceGrotesk.variable} ${inter.variable} ${geistMono.variable} bg-background text-on-background font-body selection:bg-primary-container selection:text-on-primary-container`}
      >
        {children}
      </body>
    </html>
  )
}
