import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import {
  backupNewsStore,
  backupPipelineStore,
  verifyNewsBackup,
  verifyPipelineBackup,
} from '../pipeline-store/backup'
import { loadDotenvChain } from '../pipeline-store/cli-env'
import { createActiveSourceTriageIntake } from './active-triage'
import { stableContractId } from './adapters/identity'
import { SqliteLocalCapacitySnapshot } from './local-capacity'
import {
  LegacySignalBackfillOperator,
  parseLegacySignalBackfillArgs,
  type LegacySignalBackfillIntakePort,
} from './operator-backfill'
import {
  SqliteNewsLegacyBackfillReader,
  SqlitePolymarketLegacyBackfillReader,
} from './operator-backfill-sqlite'
import type { VerifiedBackupReceipt } from './operator-recovery'
import { loadFeedV3RuntimeConfig } from './runtime-config'
import { SqliteSignalPlatformStore } from './sqlite-platform-store'

loadDotenvChain()
const PACKAGE_DIR = resolve(__dirname, '..', '..')

async function main(): Promise<void> {
  const parsed = parseLegacySignalBackfillArgs(process.argv.slice(2))
  const now = new Date().toISOString()
  const newsPath = databasePath(process.env.NEWS_SQLITE_PATH, '.data/news.sqlite')
  const pipelinePath = databasePath(process.env.PIPELINE_SQLITE_PATH, '.data/pipeline.sqlite')
  const selected = parsed.filters.sourceType ? [parsed.filters.sourceType] : ['news', 'polymarket'] as const
  // Apply always proves both legacy databases before any additive schema open;
  // a source-filtered dry-run needs only its selected read-only database.
  const required = parsed.apply ? ['news', 'polymarket'] as const : selected
  for (const source of required) {
    const path = source === 'news' ? newsPath : pipelinePath
    if (!existsSync(path)) throw new Error(`${source} SQLite database does not exist at configured path`)
  }
  const readers = selected.map((source) => source === 'news'
    ? new SqliteNewsLegacyBackfillReader(newsPath)
    : new SqlitePolymarketLegacyBackfillReader(pipelinePath))
  const stores: SqliteSignalPlatformStore[] = []
  try {
    const receipt = parsed.apply ? await createVerifiedDualBackup({ newsPath, pipelinePath, now }) : undefined
    const runtime = loadFeedV3RuntimeConfig()
    const intakes: LegacySignalBackfillIntakePort[] = parsed.apply
      ? selected.map((sourceType) => {
        const store = new SqliteSignalPlatformStore(sourceType === 'news' ? newsPath : pipelinePath, sourceType)
        stores.push(store)
        return {
          sourceType,
          intake: createActiveSourceTriageIntake({
            store,
            mode: 'observe',
            capacity: new SqliteLocalCapacitySnapshot(store),
            providerHealth: runtime.triageProviderHealth,
            classifierEnabled: runtime.triageClassifierEnabled,
            allowedDepths: [...runtime.triageAllowedDepths],
            clock: () => now,
          }),
        }
      })
      : selected.map((sourceType) => ({
        sourceType,
        intake: { mode: 'observe', ingest: async () => { throw new Error('dry-run intake is disabled') } },
      }))
    const report = await new LegacySignalBackfillOperator({ readers, intakes }).run({
      ...parsed,
      now,
      backupReceipt: receipt,
    })
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } finally {
    for (const store of stores) store.close()
    for (const reader of readers) reader.close()
  }
}

async function createVerifiedDualBackup(input: {
  newsPath: string; pipelinePath: string; now: string
}): Promise<VerifiedBackupReceipt> {
  const news = await backupNewsStore({ sourcePath: input.newsPath, now: input.now })
  const newsVerification = await verifyNewsBackup(news.path, news.sourceTableCounts)
  if (!newsVerification.ok) throw new Error(`Verified news backup failed: ${newsVerification.integrity}`)
  const pipeline = await backupPipelineStore({ sourcePath: input.pipelinePath, now: input.now })
  const pipelineVerification = await verifyPipelineBackup(pipeline.path, pipeline.sourceTableCounts)
  if (!pipelineVerification.ok) throw new Error(`Verified Polymarket backup failed: ${pipelineVerification.integrity}`)
  return {
    receiptId: stableContractId('backfill_backup', input.now, news.path, pipeline.path),
    verified: true,
    verifiedAt: new Date().toISOString(),
    sources: ['news', 'polymarket'],
  }
}

function databasePath(value: string | undefined, fallback: string): string {
  const configured = value?.trim() || fallback
  return isAbsolute(configured) ? configured : resolve(PACKAGE_DIR, configured)
}

main().catch((error) => {
  process.stderr.write(`[feed-v3-backfill] ${error instanceof Error ? error.message : 'unknown failure'}\n`)
  process.exitCode = 1
})
