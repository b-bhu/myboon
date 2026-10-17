import { envFlag, loadDotenvChain } from '../pipeline-store/cli-env'
import { appendErrorLog, installProcessErrorLogging } from '../pipeline-store/error-log'
import { resolveLaneSqlitePathFromEnv } from '../lane-store/paths'
import { runFirstThenInterval } from '../pipeline-store/interval-runner'
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
import { loadLocalTriageCapacity, SqliteLocalCapacitySnapshot } from '../signal-platform/local-capacity'
import { withSourceIntakeOwnership } from '../signal-platform/source-intake-ownership'
import { sourceOwnershipAllows, withSourceOwnershipOperation } from '../signal-platform/source-ownership'
import {
  FileSqliteWriteHealthJournal,
  resolveSqliteWriteHealthJournalPath,
} from '../signal-platform/sqlite-write-error-journal'

async function runOnce(): Promise<void> {
  const newsPath = resolveLaneSqlitePathFromEnv('news', process.env)
  const runtime = loadFeedV3RuntimeConfig()
  const intakeMode = feedV3ModeForSource(runtime, 'intake', 'news')
  const store = new SqliteNewsStore(newsPath)
  const writeHealthJournal = intakeMode !== 'off'
    ? new FileSqliteWriteHealthJournal(resolveSqliteWriteHealthJournalPath()) : null
  const canonicalStore = intakeMode !== 'off'
    ? new SqliteSignalPlatformStore(newsPath, 'news', { writeHealthJournal })
    : null
  try {
    const configuredIntake = canonicalStore
      ? intakeMode === 'active'
        ? createActiveSourceTriageIntake({
          store: canonicalStore,
          capacity: new SqliteLocalCapacitySnapshot(canonicalStore, loadLocalTriageCapacity()),
          providerHealth: runtime.triageProviderHealth,
          classifierEnabled: runtime.triageClassifierEnabled,
          allowedDepths: [...runtime.triageAllowedDepths],
          mayAdmit:() => sourceOwnershipAllows({databasePath:newsPath,source:'news',domain:'intake',owner:'shared'}),
        })
        : new CanonicalSourceSignalIntake({ mode: 'observe', store: canonicalStore })
      : undefined
    const signalIntake = configuredIntake && canonicalStore ? withSourceIntakeOwnership({
      intake:configuredIntake,observationIntake:new CanonicalSourceSignalIntake({mode:'observe',store:canonicalStore}),
      source:'news',databasePath:newsPath,
    }) : undefined
    const result = await withSourceOwnershipOperation({databasePath:newsPath,source:'news',domain:'collector',owner:'legacy',observationsOnly:true},()=>runNewsFeedIngestionOnce({store,signalIntake}))
    console.log(JSON.stringify(result, null, 2))
  } finally {
    canonicalStore?.close()
    store.close()
  }
}

async function main(): Promise<void> {
  loadDotenvChain()
  installProcessErrorLogging('news-feed-ingestor')
  await runFirstThenInterval({
    label: 'news-feed-ingestor',
    intervalMs: positiveInteger(
      process.env.NEWS_FEED_INTERVAL_MS,
      DEFAULT_NEWS_FEED_INTERVAL_MS,
    ),
    runOnce: envFlag(process.env.NEWS_FEED_RUN_ONCE),
    run: runOnce,
  })
}

main().catch((error) => {
  appendErrorLog({ app: 'news-feed-ingestor', kind: 'run_failed', error })
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
