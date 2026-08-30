'use client'

import { useEffect, useRef, useState } from 'react'
import { motion, MotionConfig } from 'framer-motion'
import { ProductPhone } from '@/components/product/ProductPhone'
import {
  HomeCanvasJourneyPhone,
  type JourneyScreen,
} from './HomeCanvasJourneyPhone'

interface Feature extends JourneyScreen {
  id: string
  headline: string
  sub: string
}

const FEATURES: Feature[] = [
  {
    id: 'feed',
    headline: 'Your market analyst, inside the feed.',
    sub: 'Developing stories, latest updates, and key dates are organized so you can quickly see what deserves your attention.',
    src: '/product/feed.png',
    alt: 'myboon feed showing developing stories and current market updates',
  },
  {
    id: 'story',
    headline: 'See how the story developed.',
    sub: 'Each story connects the latest development with earlier updates in chronological order, so you are not acting on one headline.',
    src: '/product/bitcoin-story.png',
    alt: 'myboon Bitcoin story with the latest development and historical context',
  },
  {
    id: 'markets',
    headline: 'Find the relevant market.',
    sub: 'Move into perpetuals, token swaps, prediction markets, or liquidity products without losing the context that brought you there.',
    src: '/product/market-grid-focused-v2.png',
    alt: 'myboon market selection with integrated market venues',
  },
  {
    id: 'trade',
    headline: 'Act from the same app.',
    sub: 'Check the live market, choose your direction, and place the order through an integrated Solana venue.',
    src: '/product/trade-order.png',
    alt: 'myboon BTC perpetual market and order entry screen',
  },
  {
    id: 'wallet',
    headline: 'Track everything you own.',
    sub: 'See spot assets, perpetual positions, and liquidity positions together after you act.',
    src: '/product/wallet.png',
    alt: 'myboon wallet showing assets and positions across venues',
  },
]

export function FeaturesSection() {
  const [activeIdx, setActiveIdx] = useState(0)
  const panelRefs = useRef<(HTMLDivElement | null)[]>([])

  useEffect(() => {
    const observers = panelRefs.current.map((element, index) => {
      if (!element) return null

      const observer = new IntersectionObserver(
        ([entry]) => {
          if (entry.isIntersecting) setActiveIdx(index)
        },
        { threshold: 0.5 },
      )

      observer.observe(element)
      return observer
    })

    return () => {
      observers.forEach((observer) => observer?.disconnect())
    }
  }, [])

  return (
    <MotionConfig reducedMotion="user">
      <section className="relative border-t border-outline-variant/40">
      <div className="mx-auto max-w-7xl px-6 pb-8 pt-24 lg:px-16">
        <p className="font-headline text-xs uppercase tracking-[0.25em] text-on-surface-variant/60">
          How myboon works
        </p>
      </div>

      <div className="mx-auto flex max-w-7xl">
        <div
          className="sticky top-0 hidden h-[100dvh] w-1/2 shrink-0 items-center justify-center lg:flex"
          style={{ alignSelf: 'flex-start' }}
        >
          <div className="perspective-container">
            <HomeCanvasJourneyPhone activeIndex={activeIdx} screens={FEATURES} />
          </div>
        </div>

        <div className="flex-1 lg:w-1/2">
          {FEATURES.map((feature, index) => (
            <div
              key={feature.id}
              id={feature.id}
              ref={(element) => {
                panelRefs.current[index] = element
              }}
              className="flex scroll-mt-8 flex-col items-start justify-center gap-12 px-6 py-20 lg:min-h-[100dvh] lg:px-16 lg:py-0"
            >
              <motion.div
                initial={{ opacity: 0, x: 30 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true, margin: '-20%' }}
                transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
                className="max-w-lg"
              >
                <h2 className="mb-5 font-headline text-3xl font-bold leading-tight text-on-surface lg:text-4xl">
                  {feature.headline}
                </h2>
                <p className="max-w-sm text-base leading-relaxed text-on-surface-variant">
                  {feature.sub}
                </p>
              </motion.div>

              <motion.div
                initial={{ opacity: 0, y: 22 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, amount: 0.25 }}
                transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
                className="mx-auto lg:hidden"
              >
                <ProductPhone
                  src={feature.src}
                  alt={feature.alt}
                  className="w-[252px]"
                />
              </motion.div>
            </div>
          ))}
        </div>
      </div>
      </section>
    </MotionConfig>
  )
}
