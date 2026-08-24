import { envFlag, loadDotenvChain, positiveInteger, requiredEnv } from '../pipeline-store/cli-env'

loadDotenvChain()

import { createClient } from '@supabase/supabase-js'
import { HermesService } from '../hermes'
import { withPipelineRun, PipelineStoreLedgerStore } from '../pipeline-ledger'
import { startIntervalRunner } from '../pipeline-store/interval-runner'
import { SqlitePipelineStore } from '../pipeline-store/sqlite-store'
import { ResearchEngine } from '../research-engine'
import { SupabaseEntityMemoryReader } from '../research-gate'
import { runPolymarketResearcher } from './researcher'

const DEFAULT_RESEARCHER_INTERVAL_MS = 5 * 60 * 1000

export function polymarketResearcherCliConfig(env: NodeJS.ProcessEnv = process.env): {
  runOnce: boolean
  intervalMs: number
  researchPlannerHermesToolsets: string
} {
  return {
    runOnce: envFlag(env.POLYMARKET_RESEARCHER_RUN_ONCE),
    intervalMs: positiveInteger(env.POLYMARKET_RESEARCHER_INTERVAL_MS, DEFAULT_RESEARCHER_INTERVAL_MS),
    researchPlannerHermesToolsets: env.POLYMARKET_RESEARCH_PLANNER_HERMES_TOOLSETS
      ?.split(',').map((item) => item.trim()).filter(Boolean).join(',') || 'browser',
  }
}

async function runOnce(config: ReturnType<typeof polymarketResearcherCliConfig>): Promise<void> {
  const supabase = createClient(
    requiredEnv('SUPABASE_URL'),
    requiredEnv('SUPABASE_SERVICE_ROLE_KEY')
  )

  // Local pipeline state now lives in SQLite; the researcher no longer reads
  // or writes any Supabase table directly, but still takes the client for
  // signature parity with the data-engineer stage and any future need.
  const store = new SqlitePipelineStore()
  try {
    const result = await withPipelineRun(
      new PipelineStoreLedgerStore(store),
      {
        source: 'polymarket',
        sourceArea: 'markets',
        stage: 'polymarket.researcher',
      },
      // One shared Hermes service for the whole run: the gate's cheap novelty
      // checks, the legacy planner/reflection calls (if the engine is
      // disabled) and the read-and-conclude engine all report into the same
      // per-call observability stream.
      //
      // Kill switches (each independently returns to the previous behavior):
      //   RESEARCH_GATE_DISABLED=1   - skip the pre-research entity gate
      //   RESEARCH_ENGINE_DISABLED=1 - use the legacy planner/last30days path
      () => {
        const hermes = new HermesService()
        return runPolymarketResearcher(store, supabase, {
          hermes,
          researchPlannerHermesToolsets: config.researchPlannerHermesToolsets,
          ...(process.env.RESEARCH_GATE_DISABLED === '1'
            ? {}
            : { gate: { reader: new SupabaseEntityMemoryReader(supabase) } }),
          ...(process.env.RESEARCH_ENGINE_DISABLED === '1'
            ? {}
            : { engine: new ResearchEngine({ hermes }) }),
        })
      }
    )
    console.log(JSON.stringify(result, null, 2))
  } finally {
    store.close()
  }
}

async function main(): Promise<void> {
  const config = polymarketResearcherCliConfig()
  await runOnce(config)

  // One-shot mode is only for controlled manual runs and end-to-end tests.
  // The PM2 ecosystem explicitly forces this flag to 0: a clean one-shot
  // exit combined with PM2 autorestart otherwise becomes a five-second loop.
  if (config.runOnce) return

  // Overlap guard: a single deep_web candidate can take ~11 minutes and a
  // batch can contain several, so a run can plausibly exceed this 5-minute
  // tick. Without this guard a slow tick would overlap the next one and
  // start a second concurrent researcher run against the same store.
  startIntervalRunner({
    label: 'polymarket-researcher',
    intervalMs: config.intervalMs,
    run: () => runOnce(config),
  })
}

if (require.main === module || process.env.NODE_APP_INSTANCE !== undefined) {
  main().catch((err) => {
    console.error('[polymarket-researcher] fatal:', err)
    process.exit(1)
  })
}
