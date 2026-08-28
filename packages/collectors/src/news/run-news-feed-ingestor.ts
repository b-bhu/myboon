import { envFlag, loadDotenvChain } from '../pipeline-store/cli-env'
import { resolve } from 'node:path'
import { startIntervalRunner } from '../pipeline-store/interval-runner'
import {
  DEFAULT_NEWS_FEED_INTERVAL_MS,
  positiveInteger,
} from './runtime-config'
import { SqliteNewsStore } from './sqlite-store'
import { runNewsFeedIngestionOnce } from './news-feed-ingestor'
import { CanonicalSourceSignalIntake } from '../signal-platform/source-intake'
import { feedV3ModeForSource, loadFeedV3RuntimeConfig } from '../signal-platform/runtime-config'
import { SqliteSignalPlatformStore } from '../signal-platform/sqlite-platform-store'
import { createActiveSourceTriageIntake } from '../signal-platform/active-triage'
import { SqliteLocalCapacitySnapshot } from '../signal-platform/local-capacity'
import {
  FileSqliteWriteHealthJournal,
  resolveSqliteWriteHealthJournalPath,
} from '../signal-platform/sqlite-write-error-journal'

async function runOnce(): Promise<void> {
  const newsPath = process.env.NEWS_SQLITE_PATH ?? resolve(__dirname, '..', '..', '.data', 'news.sqlite')
  const runtime = loadFeedV3RuntimeConfig()
  const intakeMode = feedV3ModeForSource(runtime, 'intake', 'news')
  const store = new SqliteNewsStore(newsPath)
  const writeHealthJournal = intakeMode !== 'off'
    ? new FileSqliteWriteHealthJournal(resolveSqliteWriteHealthJournalPath()) : null
  const canonicalStore = intakeMode !== 'off'
    ? new SqliteSignalPlatformStore(newsPath, 'news', { writeHealthJournal })
    : null
  try {
    const signalIntake = canonicalStore
      ? intakeMode === 'active'
        ? createActiveSourceTriageIntake({
          store: canonicalStore,
          capacity: new SqliteLocalCapacitySnapshot(canonicalStore),
          providerHealth: runtime.triageProviderHealth,
          classifierEnabled: runtime.triageClassifierEnabled,
          allowedDepths: [...runtime.triageAllowedDepths],
        })
        : new CanonicalSourceSignalIntake({ mode: 'observe', store: canonicalStore })
      : undefined
    const result = await runNewsFeedIngestionOnce({
      store,
      signalIntake,
    })
    console.log(JSON.stringify(result, null, 2))
  } finally {
    canonicalStore?.close()
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
