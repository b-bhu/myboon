import { loadDotenvChain, requiredEnv } from '../pipeline-store/cli-env'

loadDotenvChain()

import { createClient } from '@supabase/supabase-js'
import { buildOnDemandResponse, requestedSuggestionCount } from './on-demand'
import { GatewayXDeskProvider } from './provider'
import { runXDesk, xDeskCliConfig } from './runner'
import { SupabaseXDeskSource } from './source'
import { XDeskStore } from './store'

async function main(): Promise<void> {
  const requested = requestedSuggestionCount(process.argv[2])
  const config = xDeskCliConfig()
  const supabase = createClient(requiredEnv('SUPABASE_URL'), requiredEnv('SUPABASE_SERVICE_ROLE_KEY'))
  const store = new XDeskStore(config.dbPath)
  const source = new SupabaseXDeskSource(supabase)
  const provider = new GatewayXDeskProvider()
  const observedAt = new Date().toISOString()
  const lookbackStart = new Date(
    Date.parse(observedAt) - config.initialLookbackHours * 3_600_000,
  ).toISOString()

  try {
    const result = await runXDesk({
      source,
      store,
      provider,
      now: observedAt,
      batchSize: Math.max(config.batchSize, requested * 8),
      changePageSize: config.changePageSize,
      maxIntakePages: config.maxIntakePages,
      initialLookbackHours: config.initialLookbackHours,
      maxRecommendations: requested,
      priorPostLimit: config.priorPostLimit,
      retryDelayMs: config.retryDelayMs,
      maxAttempts: config.maxAttempts,
    })
    const candidates = store.listReadySince(lookbackStart, requested)
    console.log(JSON.stringify(buildOnDemandResponse({
      requested,
      lookbackStart,
      run: result,
      candidates,
    }), null, 2))
  } finally {
    store.close()
  }
}

main().catch((error) => {
  console.error('[x-desk] fatal:', error)
  process.exit(1)
})
