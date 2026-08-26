export const CLOB_HOST = process.env.CLOB_HOST || 'https://clob.polymarket.com'
export const RELAYER_URL = process.env.POLYMARKET_RELAYER_URL || 'https://relayer-v2.polymarket.com'
export const BRIDGE_URL = process.env.POLYMARKET_BRIDGE_URL || 'https://bridge.polymarket.com'

// Public Builder attribution code. Unlike the Builder API secret/passphrase,
// this is safe to attach to Bridge requests and may be overridden per deploy.
export const POLYMARKET_BUILDER_CODE = process.env.POLYMARKET_BUILDER_CODE
  || '0xda0aa9e10ba50d0077e25e94cf9e4d9ef749821528acf6fc758df962d67b63ed'
