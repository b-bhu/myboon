'use client'

import { motion, MotionConfig } from 'framer-motion'
import Image from 'next/image'
import { ProductPhone } from '@/components/product/ProductPhone'

const EASE = [0.22, 1, 0.36, 1] as [number, number, number, number]

const fadeUp = {
  hidden: { opacity: 0, y: 18 },
  show: { opacity: 1, y: 0, transition: { duration: 0.55, ease: EASE } },
}

const stagger = {
  hidden: {},
  show: { transition: { staggerChildren: 0.12, delayChildren: 0.1 } },
}

export default function HeroSection() {
  return (
    <MotionConfig reducedMotion="user">
      <section className="relative flex min-h-[100dvh] items-center overflow-hidden">
      {/* Background effects */}
      <div className="absolute inset-0 dot-grid opacity-[0.04] pointer-events-none" />
      <div className="absolute inset-0 hero-glow pointer-events-none" />

      <div className="relative z-10 w-full max-w-7xl mx-auto px-6 lg:px-16 py-20 flex flex-col lg:flex-row items-center gap-12 lg:gap-20">
        {/* Left: Content */}
        <motion.div
          variants={stagger}
          initial="hidden"
          animate="show"
          className="flex-1 max-w-xl"
        >
          {/* Brand mark */}
          <motion.div variants={fadeUp} className="mb-8">
            <Image
              src="/branding/myboon-app-icon-foreground-v2.svg"
              alt="myboon"
              width={144}
              height={144}
              className="-ml-6 h-32 w-32 object-contain opacity-95"
              priority
              loading="eager"
            />
          </motion.div>

          {/* Headline */}
          <motion.h1
            variants={fadeUp}
            className="mb-6 font-headline text-4xl font-bold leading-[1.08] tracking-tight text-on-surface lg:text-6xl"
          >
            Know why it moved.
            <span className="block text-tertiary">Act in the same app.</span>
          </motion.h1>

          {/* Subheadline */}
          <motion.p
            variants={fadeUp}
            className="text-lg text-on-surface-variant leading-relaxed mb-10 max-w-md"
          >
            When the market moves, myboon connects the developing story to the
            relevant Solana market and everything you own.
          </motion.p>

          {/* CTAs */}
          <motion.div variants={fadeUp} className="flex flex-col sm:flex-row items-start gap-4">
            <a
              href="https://x.com/myboonapp"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center rounded-xl bg-gradient-to-br from-primary to-primary-container px-6 py-3.5 font-headline font-bold text-on-primary shadow-2xl shadow-primary/20 transition-transform hover:scale-[1.03] active:translate-y-px"
            >
              <span className="text-sm">Follow @myboonapp</span>
            </a>
          </motion.div>
        </motion.div>

        {/* Right: current product */}
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.4, ease: EASE }}
          className="flex-shrink-0 perspective-container"
        >
          <ProductPhone
            src="/product/feed.png"
            alt="myboon feed with developing stories and current market updates"
            className="phone-container"
            priority
          />
        </motion.div>
      </div>
      </section>
    </MotionConfig>
  )
}
