import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

import { packageScriptArgs } from '../cli-args'
import {
  backupNewsStore,
  backupPipelineStore,
  verifyNewsBackup,
  verifyPipelineBackup,
} from '../pipeline-store/backup'
import { loadDotenvChain } from '../pipeline-store/cli-env'
import { stableContractId } from './adapters/identity'
import {
  CanonicalRecoveryOperator,
  parseRecoveryOperatorArgs,
  type RecoveryBackupPort,
  type RecoverySource,
  type VerifiedBackupReceipt,
} from './operator-recovery'
import { SqliteRecoveryStorePort } from './operator-recovery-sqlite'

loadDotenvChain()

const PACKAGE_DIR = resolve(__dirname, '..', '..')

function databasePath(value: string | undefined, fallback: string): string {
  const configured = value?.trim() || fallback
  return isAbsolute(configured) ? configured : resolve(PACKAGE_DIR, configured)
}

async function main(): Promise<void> {
  const parsed = parseRecoveryOperatorArgs(packageScriptArgs(process.argv.slice(2)))
  const newsPath = databasePath(process.env.NEWS_SQLITE_PATH, '.data/news.sqlite')
  const pipelinePath = databasePath(process.env.PIPELINE_SQLITE_PATH, '.data/pipeline.sqlite')
  const configured = [
    { sourceType: 'news' as const, path: newsPath },
    { sourceType: 'polymarket' as const, path: pipelinePath },
  ].filter(({ sourceType }) => parsed.filters.sourceType === undefined || parsed.filters.sourceType === sourceType)
  if (parsed.filters.sourceType !== undefined && configured.length === 0) {
    throw new Error(`No SQLite path is configured for source ${parsed.filters.sourceType}`)
  }
  for (const entry of configured) {
    if (!existsSync(entry.path)) throw new Error(`${entry.sourceType} SQLite database does not exist at configured path`)
  }

  const stores = configured.map(({ sourceType, path }) =>
    new SqliteRecoveryStorePort(path, sourceType, { readOnly: !parsed.apply }))
  const backupPort = parsed.apply ? createBackupPort({ newsPath, pipelinePath }) : null
  try {
    const result = await new CanonicalRecoveryOperator(stores, backupPort).run({
      apply: parsed.apply,
      batchSize: parsed.batchSize,
      filters: parsed.filters,
      now: new Date().toISOString(),
    })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } finally {
    for (const store of stores) store.close()
  }
}

function createBackupPort(paths: { newsPath: string; pipelinePath: string }): RecoveryBackupPort {
  return {
    async createVerifiedBackup(input): Promise<VerifiedBackupReceipt> {
      const receipts: string[] = []
      for (const source of input.sources) {
        if (source === 'news') {
          const backup = await backupNewsStore({ sourcePath: paths.newsPath, now: input.requestedAt })
          const verification = await verifyNewsBackup(backup.path, backup.sourceTableCounts)
          if (!verification.ok) throw new Error(`Verified news backup failed: ${verification.integrity}`)
          receipts.push(backup.path)
        } else if (source === 'polymarket') {
          const backup = await backupPipelineStore({ sourcePath: paths.pipelinePath, now: input.requestedAt })
          const verification = await verifyPipelineBackup(backup.path, backup.sourceTableCounts)
          if (!verification.ok) throw new Error(`Verified Polymarket backup failed: ${verification.integrity}`)
          receipts.push(backup.path)
        } else {
          throw new Error(`No SQLite backup mapping is configured for ${source}`)
        }
      }
      return {
        receiptId: stableContractId('recovery_backup', input.requestedAt, ...receipts),
        verified: true,
        verifiedAt: new Date().toISOString(),
        sources: [...input.sources] as RecoverySource[],
      }
    },
  }
}

main().catch((error) => {
  process.stderr.write(`[feed-v3-recovery] ${error instanceof Error ? error.message : 'unknown failure'}\n`)
  process.exitCode = 1
})
