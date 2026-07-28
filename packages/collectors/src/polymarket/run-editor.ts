import { config as loadEnv } from 'dotenv'

loadEnv({ path: '.env' })
loadEnv({ path: '../../.env' })
loadEnv()

import { SqlitePipelineStore } from '../pipeline-store/sqlite-store'
import { runPolymarketEditor } from './editor'

const DEFAULT_INTERVAL_MS = 90 * 60 * 1000

function envNumber(name: string, fallback: number): number {
  const parsed = Number(process.env[name])
  return Number.isFinite(parsed) ? parsed : fallback
}

async function runOnce(): Promise<void> {
  // Editor decisions/research now live in the local pipeline store; this
  // stage has no remaining Supabase dependency.
  const store = new SqlitePipelineStore()
  try {
    const result = await runPolymarketEditor(store)
    console.log(JSON.stringify(result, null, 2))
  } finally {
    store.close()
  }
}

async function main(): Promise<void> {
  await runOnce()

  if (process.env.POLYMARKET_EDITOR_RUN_ONCE === '1') return

  setInterval(() => {
    runOnce().catch((err) => {
      console.error('[polymarket-editor] run failed:', err)
    })
  }, envNumber('POLYMARKET_EDITOR_INTERVAL_MS', DEFAULT_INTERVAL_MS))
}

main().catch((err) => {
  console.error('[polymarket-editor] fatal:', err)
  process.exit(1)
})
