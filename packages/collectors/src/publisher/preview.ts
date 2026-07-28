import { config as loadEnv } from 'dotenv'

loadEnv({ path: '.env' })
loadEnv({ path: '../../.env' })
loadEnv()

import { createClient } from '@supabase/supabase-js'
import { SqlitePipelineStore } from '../pipeline-store/sqlite-store'
import { publisherCliConfig, runPublisher } from './runner'
import { SupabasePublisherStore } from './supabase-store'

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

async function main(): Promise<void> {
  const config = publisherCliConfig()
  const supabase = createClient(
    requiredEnv('SUPABASE_URL'),
    requiredEnv('SUPABASE_SERVICE_ROLE_KEY')
  )
  const pipelineStore = new SqlitePipelineStore()
  try {
    const result = await runPublisher({
      store: new SupabasePublisherStore(supabase, pipelineStore),
      batchSize: config.batchSize,
      dryRun: true,
    })
    console.log(JSON.stringify(result, null, 2))
  } finally {
    pipelineStore.close()
  }
}

main().catch((err) => {
  console.error('[publisher:preview] fatal:', err)
  process.exit(1)
})
