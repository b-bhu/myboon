'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { variantFromUA, type Variant } from './ua'

/**
 * Server picks the variant from the request UA so the first paint is right.
 * This re-checks on the client for cases the header can't see
 * (a cached page, or iPadOS sending a desktop Mac UA).
 */
export default function VariantGuard({ initial, views }: { initial: Variant; views: Record<Variant, ReactNode> }) {
  const [v, setV] = useState<Variant>(initial)
  useEffect(() => {
    let next = variantFromUA(navigator.userAgent)
    if (next === 'desktop' && /Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1) next = 'ios'
    if (next !== initial) setV(next)
  }, [initial])
  return <>{views[v]}</>
}
