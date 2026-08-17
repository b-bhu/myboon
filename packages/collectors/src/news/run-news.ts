import { HermesWorkerClient } from './hermes-client'
import { runNewsResearchPipelineOnce } from './runner'
import {
  newsResearchBacklogWarnAgeMs,
  newsResearchBacklogWarnCount,
  newsResearchBatchSize,
  newsResearchConcurrency,
  positiveInteger,
} from './runtime-config'
import { SqliteNewsStore } from './sqlite-store'

const store = new SqliteNewsStore(process.env.NEWS_SQLITE_PATH)
const hermes = new HermesWorkerClient()
const options = {
  batchSize: newsResearchBatchSize(),
  concurrency: newsResearchConcurrency(),
  researchTimeoutMs: positiveInteger(process.env.NEWS_RESEARCH_TIMEOUT_MS, 10 * 60_000),
  staleWorkCutoffMs: positiveInteger(process.env.NEWS_STALE_WORK_CUTOFF_MS, 30 * 60_000),
  backlogWarnCount: newsResearchBacklogWarnCount(),
  backlogWarnAgeMs: newsResearchBacklogWarnAgeMs(),
}

const pipeline = runNewsResearchPipelineOnce({ store, hermes, options })

pipeline.then((result) => {
  if (result.backlog.warning) {
    console.warn('[news-researcher] backlog warning', JSON.stringify(result.backlog))
  }
  console.log(JSON.stringify(result, null, 2))
})
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
  .finally(() => {
    store.close()
  })
