// Defaults only. bootstrap/config.ts reads CLOB_HOST, POLYMARKET_RELAYER_URL,
// POLYMARKET_BRIDGE_URL and POLYMARKET_BUILDER_CODE and passes them down.
export const DEFAULT_CLOB_HOST = 'https://clob.polymarket.com'
export const DEFAULT_RELAYER_URL = 'https://relayer-v2.polymarket.com'
export const DEFAULT_BRIDGE_URL = 'https://bridge.polymarket.com'

// Public Builder attribution code. Unlike the Builder API secret/passphrase,
// this is safe to attach to Bridge requests and may be overridden per deploy.
export const DEFAULT_POLYMARKET_BUILDER_CODE = '0xda0aa9e10ba50d0077e25e94cf9e4d9ef749821528acf6fc758df962d67b63ed'
