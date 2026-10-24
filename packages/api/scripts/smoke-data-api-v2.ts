/**
 * Live smoke check of the Polymarket Data API v2 helper (issue #426).
 *
 * Read-only: one public wallet address, no secrets. Walks the v2 routes the
 * portfolio screens need, printing route, row count and the first row's keys.
 * Run with: cd packages/api && npx tsx scripts/smoke-data-api-v2.ts
 */

import { dataApiV2Get, dataApiV2List } from '../src/polymarket/read/data-api-v2.js'

/** Public test wallet documented in the #426 issue (no private key involved). */
const WALLET = '0x56687bf447db6ffa42ffe2204a05edaa20f55839'

const LIST_CALLS: { route: string; params: Record<string, string>; cap: number }[] = [
  { route: 'positions', params: { user: WALLET, status: 'OPEN' }, cap: 100 },
  { route: 'positions', params: { user: WALLET, status: 'REDEEMABLE' }, cap: 50 },
  { route: 'positions', params: { user: WALLET, status: 'CLOSED' }, cap: 50 },
  { route: 'activity', params: { user: WALLET }, cap: 500 },
]

const firstRowKeys = (rows: Record<string, unknown>[]): string =>
  rows.length > 0 ? Object.keys(rows[0]).sort().join(',') : '(none)'

async function main(): Promise<void> {
  let failures = 0

  try {
    const value = await dataApiV2Get<{ proxy_wallet: string; value: string }>('value', { user: WALLET })
    const valueRows = value ? [value as unknown as Record<string, unknown>] : []
    console.log(`value?user=${WALLET} rows=1 keys=${value ? Object.keys(value).sort().join(',') : '(data:null)'}`)
    if (value) console.log(`  -> portfolio value: ${value.value} USDC for ${value.proxy_wallet}`)
  } catch (err) {
    failures++
    console.error(`value?user=${WALLET} FAILED:`, err instanceof Error ? err.message : err)
  }

  for (const call of LIST_CALLS) {
    try {
      const rows = await dataApiV2List(call.route, call.params, { cap: call.cap })
      const paramText = Object.entries(call.params)
        .map(([key, val]) => `${key}=${val}`)
        .join('&')
      console.log(`${call.route}?${paramText} cap=${call.cap} rows=${rows.length} keys=${firstRowKeys(rows)}`)
    } catch (err) {
      failures++
      console.error(`${call.route} FAILED:`, err instanceof Error ? err.message : err)
    }
  }

  process.exitCode = failures > 0 ? 1 : 0
}

void main()