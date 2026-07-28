import { loadDotenvChain } from '../pipeline-store/cli-env'

loadDotenvChain()

import { startIntervalRunner } from '../pipeline-store/interval-runner'
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

  startIntervalRunner({
    label: 'polymarket-editor',
    intervalMs: envNumber('POLYMARKET_EDITOR_INTERVAL_MS', DEFAULT_INTERVAL_MS),
    run: runOnce,
  })
}

main().catch((err) => {
  console.error('[polymarket-editor] fatal:', err)
  process.exit(1)
})
