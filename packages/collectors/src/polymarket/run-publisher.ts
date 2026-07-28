import { config as loadEnv } from 'dotenv'

loadEnv({ path: '.env' })
loadEnv({ path: '../../.env' })
loadEnv()

import { createClient } from '@supabase/supabase-js'
import { SqlitePipelineStore } from '../pipeline-store/sqlite-store'
import { runPolymarketPublisher } from './publisher'

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000

function envNumber(name: string, fallback: number): number {
  const parsed = Number(process.env[name])
  return Number.isFinite(parsed) ? parsed : fallback
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

async function runOnce(): Promise<void> {
  const supabase = createClient(
    requiredEnv('SUPABASE_URL'),
    requiredEnv('SUPABASE_SERVICE_ROLE_KEY')
  )
  const store = new SqlitePipelineStore()

  try {
    const result = await runPolymarketPublisher(store, supabase)
    console.log(JSON.stringify(result, null, 2))
  } finally {
    store.close()
  }
}

async function main(): Promise<void> {
  await runOnce()

  if (process.env.POLYMARKET_PUBLISHER_RUN_ONCE === '1') return

  setInterval(() => {
    runOnce().catch((err) => {
      console.error('[polymarket-publisher] run failed:', err)
    })
  }, envNumber('POLYMARKET_PUBLISHER_INTERVAL_MS', DEFAULT_INTERVAL_MS))
}

main().catch((err) => {
  console.error('[polymarket-publisher] fatal:', err)
  process.exit(1)
})
