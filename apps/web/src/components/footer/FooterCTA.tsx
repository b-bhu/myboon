'use client'

import { motion, MotionConfig } from 'framer-motion'
import Image from 'next/image'

export function FooterCTA() {
  return (
    <MotionConfig reducedMotion="user">
      <section className="relative border-t border-outline-variant/40 py-32">
      <div className="max-w-3xl mx-auto px-6 lg:px-16 text-center">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          className="flex flex-col items-center gap-8"
        >
          <Image
            src="/branding/myboon-app-icon-foreground-v2.svg"
            alt="myboon"
            width={128}
            height={128}
            className="h-28 w-28 object-contain opacity-80"
          />

          <h2 className="font-headline font-bold text-2xl lg:text-3xl text-on-surface leading-tight">
            Know why the market moved.
            <br />
            <span className="text-tertiary">Act in the same app.</span>
          </h2>

          <p className="max-w-md text-sm leading-relaxed text-on-surface-variant/70">
            myboon is being prepared for beta on Solana Mobile.
          </p>

          {/* CTA */}
          <a
            href="https://x.com/myboonapp"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center rounded-xl bg-gradient-to-br from-primary to-primary-container px-8 py-4 font-headline font-bold text-on-primary shadow-2xl shadow-primary/20 transition-transform hover:scale-[1.03] active:translate-y-px"
          >
            <span className="text-sm">Follow @myboonapp</span>
          </a>

          {/* Links */}
          <div className="flex items-center gap-6 mt-4">
            <a
              href="https://github.com/bucketshop69/myboon"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-on-surface-variant/40 hover:text-on-surface-variant transition-colors font-headline"
            >
              GitHub
            </a>
            <span className="text-on-surface-variant/20">/</span>
            <span className="text-xs text-on-surface-variant/30 font-headline">
              Built on Solana
            </span>
          </div>
        </motion.div>
      </div>
      </section>
    </MotionConfig>
  )
}
