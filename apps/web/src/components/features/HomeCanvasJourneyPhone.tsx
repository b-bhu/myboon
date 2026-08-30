'use client'

import { AnimatePresence, motion } from 'framer-motion'
import { ProductPhone } from '@/components/product/ProductPhone'

export interface JourneyScreen {
  src: string
  alt: string
}

interface HomeCanvasJourneyPhoneProps {
  activeIndex: number
  screens: JourneyScreen[]
}

export function HomeCanvasJourneyPhone({
  activeIndex,
  screens,
}: HomeCanvasJourneyPhoneProps) {
  const clampedIndex = Math.max(0, Math.min(activeIndex, screens.length - 1))
  const screen = screens[clampedIndex]

  return (
    <div className="relative h-[654px] w-[278px]">
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={screen.src}
          initial={{ opacity: 0, y: 18, scale: 0.985 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -12, scale: 0.99 }}
          transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
          className="absolute inset-x-0 top-0"
        >
          <ProductPhone src={screen.src} alt={screen.alt} className="w-[278px]" />
        </motion.div>
      </AnimatePresence>
    </div>
  )
}
