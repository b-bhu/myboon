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
  // LEGACY LANE GUARD (PR review finding): this research-row editor lane is
  // intentionally NOT in ecosystem.config.cjs - production runs the
  // entity-draft lane (editor-draft/ + publisher/), which writes
  // published_narratives with a different column set. Running this lane by
  // accident would produce rows the new pipeline's consumers don't expect.
  if (process.env.POLYMARKET_LEGACY_RESEARCH_LANE !== 'I_UNDERSTAND') {
    console.error(
      '[polymarket-editor] REFUSING TO START: legacy research-row editor lane. '
      + 'Production uses the entity-draft lane (editor-draft/ + publisher/). '
      + 'Set POLYMARKET_LEGACY_RESEARCH_LANE=I_UNDERSTAND to run it anyway.'
    )
    process.exit(1)
  }

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
