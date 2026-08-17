import { envFlag, loadDotenvChain } from '../pipeline-store/cli-env'
import { startIntervalRunner } from '../pipeline-store/interval-runner'
import {
  DEFAULT_NEWS_FEED_INTERVAL_MS,
  positiveInteger,
} from './runtime-config'
import { SqliteNewsStore } from './sqlite-store'
import { runNewsFeedIngestionOnce } from './news-feed-ingestor'

async function runOnce(): Promise<void> {
  const store = new SqliteNewsStore(process.env.NEWS_SQLITE_PATH)
  try {
    const result = await runNewsFeedIngestionOnce({
      store,
    })
    console.log(JSON.stringify(result, null, 2))
  } finally {
    store.close()
  }
}

async function main(): Promise<void> {
  loadDotenvChain()
  await runOnce()
  if (envFlag(process.env.NEWS_FEED_RUN_ONCE)) return

  startIntervalRunner({
    label: 'news-feed-ingestor',
    intervalMs: positiveInteger(
      process.env.NEWS_FEED_INTERVAL_MS,
      DEFAULT_NEWS_FEED_INTERVAL_MS,
    ),
    run: runOnce,
  })
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
