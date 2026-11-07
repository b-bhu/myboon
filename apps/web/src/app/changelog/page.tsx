'use client'

import { motion } from 'framer-motion'
import Link from 'next/link'

type ChangelogEntry = {
  date: string
  version: string
  title: string
  description: string
  tags: string[]
}

const CHANGELOG: ChangelogEntry[] = [
  {
    date: '2026-04-09',
    version: '0.8.0',
    title: 'Polymarket UI redesign — 3-zone layout, tabs, bet slip',
    description:
      'Rebuilt the Polymarket detail screens with a 3-zone layout, tabbed navigation, and an integrated bet slip for faster position entry.',
    tags: ['mobile', 'polymarket'],
  },
  {
    date: '2026-04-07',
    version: '0.7.1',
    title: 'Solana wallet connect + web fallback',
    description:
      'Added a Connect button to the mobile header with Solana Mobile Wallet Adapter and a web wallet fallback for browser testing.',
    tags: ['mobile', 'wallet'],
  },
  {
    date: '2026-04-05',
    version: '0.7.0',
    title: 'Multi-format odds display',
    description:
      'Odds can now be shown as decimal, points, or probability — user picks their preferred format.',
    tags: ['mobile', 'polymarket'],
  },
  {
    date: '2026-04-03',
    version: '0.6.0',
    title: 'Solana Mobile Wallet Adapter',
    description:
      'Integrated MWA SDK for native wallet signing on Solana Seeker and other Android devices.',
    tags: ['mobile', 'wallet'],
  },
  {
    date: '2026-03-30',
    version: '0.5.0',
    title: 'Polymarket UI + trending strip + sparklines',
    description:
      'New Polymarket tab with a trending market strip, inline sparkline charts, and refreshed trade screen layout.',
    tags: ['mobile', 'polymarket'],
  },
  {
    date: '2026-03-28',
    version: '0.4.0',
    title: 'Dome migration + Polymarket API',
    description:
      'Migrated the API layer to Dome architecture and added prediction market endpoints for market data and pricing.',
    tags: ['api', 'polymarket'],
  },
  {
    date: '2026-03-25',
    version: '0.3.0',
    title: 'Pacific perps Trade tab',
    description:
      'Full Trade tab UI with action dock for Pacific perpetual markets — long, short, and limit orders.',
    tags: ['mobile', 'trade'],
  },
  {
    date: '2026-03-23',
    version: '0.2.0',
    title: 'Marketing site — sticky scroll features section',
    description:
      'Apple-style sticky scroll for the features section on the marketing site, plus the Newsroom inline visualization.',
    tags: ['web'],
  },
  {
    date: '2026-03-20',
    version: '0.1.0',
    title: 'crypto_god broadcaster + Pacific collectors',
    description:
      'Launched the crypto_god Pacific perps broadcaster brain, plus liquidation, OI surge, and funding spike collectors.',
    tags: ['brain', 'collectors'],
  },
]

const TAG_COLORS: Record<string, string> = {
  mobile: 'bg-tertiary/15 text-tertiary',
  polymarket: 'bg-primary/15 text-primary',
  wallet: 'bg-secondary/20 text-secondary',
  api: 'bg-primary-fixed/15 text-primary-fixed',
  trade: 'bg-tertiary/15 text-tertiary',
  web: 'bg-secondary/20 text-secondary',
  brain: 'bg-error/15 text-error',
  collectors: 'bg-error/10 text-error',
}

const EASE = [0.22, 1, 0.36, 1] as [number, number, number, number]

function formatDate(dateStr: string) {
  const d = new Date(dateStr + 'T00:00:00')
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

export default function ChangelogPage() {
  return (
    <main className="min-h-screen">
      {/* Header */}
      <div className="border-b border-outline-variant">
        <div className="max-w-3xl mx-auto px-6 py-8 flex items-center justify-between">
          <Link
            href="/"
            className="text-on-surface-variant hover:text-primary transition-colors font-headline text-sm flex items-center gap-1"
          >
            <span className="material-symbols-outlined text-lg">
              arrow_back
            </span>
            Home
          </Link>
          <img
            src="/branding/myboon-wordmark-small@2x.png"
            alt="myboon"
            className="h-8 opacity-70"
          />
        </div>
      </div>

      {/* Title */}
      <div className="max-w-3xl mx-auto px-6 pt-16 pb-12">
        <motion.p
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: EASE }}
          className="text-xs font-headline tracking-widest text-primary uppercase mb-3"
        >
          What&apos;s new
        </motion.p>
        <motion.h1
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.1, ease: EASE }}
          className="text-3xl lg:text-4xl font-headline font-bold text-on-surface mb-4"
        >
          Changelog
        </motion.h1>
        <motion.p
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.2, ease: EASE }}
          className="text-on-surface-variant text-base max-w-xl"
        >
          Follow along as we build myboon — narrative intelligence for on-chain
          traders.
        </motion.p>
      </div>

      {/* Entries */}
      <div className="max-w-3xl mx-auto px-6 pb-24">
        <div className="relative">
          {/* Timeline line */}
          <div className="absolute left-[7px] top-2 bottom-2 w-px bg-outline-variant" />

          <div className="space-y-12">
            {CHANGELOG.map((entry, i) => (
              <motion.div
                key={entry.version}
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-5%' }}
                transition={{
                  duration: 0.5,
                  delay: Math.min(i * 0.05, 0.2),
                  ease: EASE,
                }}
                className="relative pl-8"
              >
                {/* Timeline dot */}
                <div className="absolute left-0 top-[6px] w-[15px] h-[15px] rounded-full border-2 border-primary bg-background" />

                {/* Date + version */}
                <div className="flex items-center gap-3 mb-2">
                  <time className="text-xs font-headline tracking-wider text-on-surface-variant uppercase">
                    {formatDate(entry.date)}
                  </time>
                  <span className="text-xs font-headline tracking-wider text-outline">
                    {entry.version}
                  </span>
                </div>

                {/* Title */}
                <h3 className="text-lg font-headline font-medium text-on-surface mb-2">
                  {entry.title}
                </h3>

                {/* Description */}
                <p className="text-sm text-on-surface-variant leading-relaxed mb-3">
                  {entry.description}
                </p>

                {/* Tags */}
                <div className="flex flex-wrap gap-2">
                  {entry.tags.map((tag) => (
                    <span
                      key={tag}
                      className={`text-[10px] font-headline tracking-widest uppercase px-2 py-0.5 rounded-sm ${TAG_COLORS[tag] ?? 'bg-surface-container text-on-surface-variant'}`}
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </div>
    </main>
  )
}
