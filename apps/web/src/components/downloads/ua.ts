export type Variant = 'android' | 'ios' | 'desktop'

export const STORE_URL = 'solanadappstore://details?id=xyz.myboon.app'

/** Pick the /downloads state from a user-agent string. Unknown or missing UA falls back to desktop (QR). */
export function variantFromUA(ua: string | null | undefined): Variant {
  if (!ua) return 'desktop'
  if (/android/i.test(ua)) return 'android'
  if (/iphone|ipad|ipod/i.test(ua)) return 'ios'
  return 'desktop'
}
