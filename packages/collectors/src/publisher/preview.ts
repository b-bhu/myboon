import { loadDotenvChain, requiredEnv } from '../pipeline-store/cli-env'

loadDotenvChain()

import { createSupabaseClient } from '@myboon/shared/supabase-client'
import { SqlitePipelineStore } from '../pipeline-store/sqlite-store'
import { resolveLaneSqlitePathFromEnv } from '../lane-store/paths'
import { publisherCliConfig, runPublisher } from './runner'
import { SupabasePublisherStore } from './supabase-store'
import { createEntityKnowledgeReader } from '../entity-manager/entity-knowledge-reader-factory'

async function main(): Promise<void> {
  const config = publisherCliConfig()
  const supabase = createSupabaseClient(
    requiredEnv('SUPABASE_URL'),
    requiredEnv('SUPABASE_SERVICE_ROLE_KEY')
  )
  const pipelineStore = new SqlitePipelineStore(resolveLaneSqlitePathFromEnv('polymarket', process.env))
  try {
    const result = await runPublisher({
      store: new SupabasePublisherStore(
        supabase,
        pipelineStore,
        createEntityKnowledgeReader(supabase),
      ),
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
