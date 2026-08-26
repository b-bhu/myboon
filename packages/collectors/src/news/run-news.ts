import { envFlag, loadDotenvChain } from '../pipeline-store/cli-env'
import { startIntervalRunner } from '../pipeline-store/interval-runner'
import { legacyResearchOwnership, runLegacyResearchWhenOwned } from '../research-engine/legacy-ownership-guard'
import { HermesWorkerClient } from './hermes-client'
import { runNewsResearchPipelineOnce } from './runner'
import {
  newsResearchBacklogWarnAgeMs,
  newsResearchBacklogWarnCount,
  newsResearchBatchSize,
  newsResearchConcurrency,
  newsResearchIntervalMs,
  positiveInteger,
} from './runtime-config'
import { SqliteNewsStore } from './sqlite-store'

async function runOnce(): Promise<void> {
  const store = new SqliteNewsStore(process.env.NEWS_SQLITE_PATH)
  try {
    const result = await runNewsResearchPipelineOnce({
      store,
      hermes: new HermesWorkerClient(),
      options: {
        batchSize: newsResearchBatchSize(),
        concurrency: newsResearchConcurrency(),
        researchTimeoutMs: positiveInteger(process.env.NEWS_RESEARCH_TIMEOUT_MS, 10 * 60_000),
        staleWorkCutoffMs: positiveInteger(process.env.NEWS_STALE_WORK_CUTOFF_MS, 30 * 60_000),
        backlogWarnCount: newsResearchBacklogWarnCount(),
        backlogWarnAgeMs: newsResearchBacklogWarnAgeMs(),
      },
    })
    if (result.backlog.warning) {
      console.warn('[news-researcher] backlog warning', JSON.stringify(result.backlog))
    }
    console.log(JSON.stringify(result, null, 2))
  } finally {
    store.close()
  }
}

async function main(): Promise<void> {
  loadDotenvChain()
  const { ownership } = await runLegacyResearchWhenOwned({ sourceType: 'news', run: runOnce })
  if (ownership.owner === 'shared') {
    console.log('[news-researcher] shared Research owns news; legacy runner is inert')
    if (envFlag(process.env.NEWS_RESEARCHER_RUN_ONCE)) return
    await waitForShutdownSignal()
    return
  }
  if (envFlag(process.env.NEWS_RESEARCHER_RUN_ONCE)) return

  startIntervalRunner({
    label: 'news-researcher',
    intervalMs: newsResearchIntervalMs(),
    run: runOnce,
  })
}

function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolve) => {
    const stop = () => {
      process.removeListener('SIGTERM', stop)
      process.removeListener('SIGINT', stop)
      resolve()
    }
    process.once('SIGTERM', stop)
    process.once('SIGINT', stop)
  })
}

export function newsResearchRunnerOwnership(
  env: Readonly<Record<string, string | undefined>>,
  now?: Date,
) {
  return legacyResearchOwnership('news', env, now)
}

if (require.main === module || process.env.NODE_APP_INSTANCE !== undefined) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
