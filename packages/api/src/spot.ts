import { Hono } from 'hono'

// Helius DAS API (getAssetsByOwner) — same JSON-RPC endpoint as HELIUS_RPC_URL
// used elsewhere in this repo. The Helius key is
// metered/paid, unlike the free public RPC Meteora/Pacifica fall back to, so
// this call must stay server-side and never be exposed via an
// `EXPO_PUBLIC_*` client env var.
const HELIUS_RPC_URL = process.env.HELIUS_RPC_URL || ''
const BALANCES_CACHE_TTL_MS = 15_000
const SOLANA_ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

const balancesCache = new Map<string, { data: SpotWalletBalances; expiresAt: number }>()

interface HeliusTokenInfo {
  symbol?: string
  balance?: number
  supply?: number
  decimals?: number
  price_info?: {
    price_per_token?: number
    total_price?: number
    currency?: string
  }
}

interface HeliusAsset {
  id: string
  interface?: string
  content?: {
    metadata?: { name?: string; symbol?: string }
    links?: { image?: string }
  }
  token_info?: HeliusTokenInfo
}

interface HeliusGetAssetsByOwnerResult {
  items?: HeliusAsset[]
  nativeBalance?: {
    lamports?: number
    price_per_sol?: number
    total_price?: number
  }
}

interface SpotTokenBalance {
  mint: string
  symbol: string | null
  name: string | null
  icon: string | null
  decimals: number
  amount: string
  uiAmount: number
  priceUsd: number | null
  valueUsd: number | null
}

interface SpotWalletBalances {
  wallet: string
  totalValueUsd: number | null
  tokens: SpotTokenBalance[]
}

const NATIVE_SOL_MINT = 'So11111111111111111111111111111111111111112'

function isPlausibleSolanaAddress(value: string): boolean {
  return SOLANA_ADDRESS_PATTERN.test(value)
}

async function heliusRpc<T>(method: string, params: unknown): Promise<T> {
  if (!HELIUS_RPC_URL) throw new Error('HELIUS_RPC_URL not configured')

  const res = await fetch(HELIUS_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'myboon-spot', method, params }),
  })

  if (!res.ok) {
    throw new Error(`Helius ${method} failed (${res.status})`)
  }

  const json = await res.json() as { result?: T; error?: { message?: string } }
  if (json.error) throw new Error(json.error.message ?? `Helius ${method} returned an error`)
  if (json.result === undefined) throw new Error(`Helius ${method} returned no result`)
  return json.result
}

// This screen's total is user-facing net worth — a NaN/Infinity/negative
// value from upstream must never silently flow into a sum a user reads as
// their balance. `typeof x === 'number'` alone accepts all three.
function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function fungibleTokenBalance(asset: HeliusAsset): SpotTokenBalance | null {
  const info = asset.token_info
  if (!info || !isFiniteNonNegative(info.balance) || !isFiniteNonNegative(info.decimals)) return null

  const uiAmount = info.balance / 10 ** info.decimals
  const priceUsd = isFiniteNonNegative(info.price_info?.price_per_token) ? info.price_info!.price_per_token! : null
  const rawTotalPrice = info.price_info?.total_price
  const valueUsd = isFiniteNonNegative(rawTotalPrice)
    ? rawTotalPrice
    : (priceUsd !== null ? priceUsd * uiAmount : null)

  return {
    mint: asset.id,
    symbol: asset.content?.metadata?.symbol ?? info.symbol ?? null,
    name: asset.content?.metadata?.name ?? null,
    icon: asset.content?.links?.image ?? null,
    decimals: info.decimals,
    amount: String(info.balance),
    uiAmount,
    priceUsd,
    valueUsd,
  }
}

function nativeSolBalance(result: HeliusGetAssetsByOwnerResult): SpotTokenBalance | null {
  const native = result.nativeBalance
  if (!native || !isFiniteNonNegative(native.lamports) || native.lamports <= 0) return null

  const uiAmount = native.lamports / 1e9
  const priceUsd = isFiniteNonNegative(native.price_per_sol) ? native.price_per_sol! : null
  const valueUsd = isFiniteNonNegative(native.total_price)
    ? native.total_price!
    : (priceUsd !== null ? priceUsd * uiAmount : null)

  return {
    mint: NATIVE_SOL_MINT,
    symbol: 'SOL',
    name: 'Solana',
    icon: null,
    decimals: 9,
    amount: String(native.lamports),
    uiAmount,
    priceUsd,
    valueUsd,
  }
}

/** Shared by the /spot routes and the wallet summary's spot venue (#742). */
export async function fetchWalletBalances(wallet: string): Promise<SpotWalletBalances> {
  const cached = balancesCache.get(wallet)
  const now = Date.now()
  if (cached && cached.expiresAt > now) return cached.data

  const result = await heliusRpc<HeliusGetAssetsByOwnerResult>('getAssetsByOwner', {
    ownerAddress: wallet,
    page: 1,
    limit: 1000,
    displayOptions: {
      showFungible: true,
      showNativeBalance: true,
      showZeroBalance: false,
    },
  })

  const tokens: SpotTokenBalance[] = []
  const sol = nativeSolBalance(result)
  if (sol) tokens.push(sol)

  for (const asset of result.items ?? []) {
    if (asset.interface !== 'FungibleToken' && asset.interface !== 'FungibleAsset') continue
    const token = fungibleTokenBalance(asset)
    if (token) tokens.push(token)
  }

  tokens.sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0))

  // A wallet holding zero tokens, or holding only tokens Helius has no price
  // for, is a legitimate $0 total — not a failure. `null` is reserved for a
  // genuine upstream/parse problem (handled by the route's try/catch below);
  // an empty knownValues list here must never be conflated with that case.
  const knownValues = tokens.map((token) => token.valueUsd).filter((value): value is number => value !== null)
  const totalValueUsd = knownValues.reduce((sum, value) => sum + value, 0)

  const data: SpotWalletBalances = { wallet, totalValueUsd, tokens }
  balancesCache.set(wallet, { data, expiresAt: now + BALANCES_CACHE_TTL_MS })
  return data
}

export const spotRoutes = new Hono()

// GET /spot/:wallet/balances — all token balances for the wallet, priced in USD.
spotRoutes.get('/:wallet/balances', async (c) => {
  const wallet = c.req.param('wallet')
  if (!isPlausibleSolanaAddress(wallet)) {
    return c.json({ error: 'Invalid wallet address', code: 'INVALID_ADDRESS' }, 400)
  }

  try {
    return c.json(await fetchWalletBalances(wallet))
  } catch (err) {
    console.error(`[api] Spot balances for ${wallet} unavailable:`, err instanceof Error ? err.message : err)
    return c.json({ error: 'Spot balances unavailable' }, 502)
  }
})

// GET /spot/:wallet/balances/:mint — balance for one specific mint (404 if not held).
spotRoutes.get('/:wallet/balances/:mint', async (c) => {
  const wallet = c.req.param('wallet')
  const mint = c.req.param('mint')
  if (!isPlausibleSolanaAddress(wallet)) {
    return c.json({ error: 'Invalid wallet address', code: 'INVALID_ADDRESS' }, 400)
  }
  if (!isPlausibleSolanaAddress(mint)) {
    return c.json({ error: 'Invalid mint address', code: 'INVALID_ADDRESS' }, 400)
  }

  try {
    const balances = await fetchWalletBalances(wallet)
    const token = balances.tokens.find((candidate) => candidate.mint === mint)
    if (!token) return c.json({ error: 'Mint not held by wallet' }, 404)
    return c.json(token)
  } catch (err) {
    console.error(`[api] Spot balance for ${wallet}/${mint} unavailable:`, err instanceof Error ? err.message : err)
    return c.json({ error: 'Spot balance unavailable' }, 502)
  }
})
