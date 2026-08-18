import { loadDotenvChain } from './cli-env'

loadDotenvChain()

import {
  backupNewsStore,
  backupPipelineStore,
  pruneOldBackups,
  verifyNewsBackup,
  verifyPipelineBackup,
} from './backup'

async function runOnce(): Promise<void> {
  const sourcePath = process.env.PIPELINE_SQLITE_PATH
  const newsSourcePath = process.env.NEWS_SQLITE_PATH
  const backupDir = process.env.PIPELINE_BACKUP_DIR
  const keepRaw = process.env.PIPELINE_BACKUP_KEEP
  const keep = keepRaw ? Number(keepRaw) : undefined

  const backupResult = await backupPipelineStore({ sourcePath, backupDir })
  const newsBackupResult = await backupNewsStore({ sourcePath: newsSourcePath, backupDir })
  // Verify the backup FILE against the SOURCE database's counts - passing
  // the backup's own counts here compared the backup against itself and
  // could never detect a dropped row (PR review finding).
  const verification = await verifyPipelineBackup(backupResult.path, backupResult.sourceTableCounts)
  const newsVerification = await verifyNewsBackup(newsBackupResult.path, newsBackupResult.sourceTableCounts)
  const deletedBackups = await pruneOldBackups({
    backupDir,
    keep: Number.isFinite(keep) ? keep : undefined,
  })
  const deletedNewsBackups = await pruneOldBackups({
    backupDir,
    keep: Number.isFinite(keep) ? keep : undefined,
    prefix: 'news-',
  })

  const summary = {
    pipeline: { backup: backupResult, verification, pruned: deletedBackups },
    news: { backup: newsBackupResult, verification: newsVerification, pruned: deletedNewsBackups },
  }
  console.log(JSON.stringify(summary, null, 2))

  if (!verification.ok || !newsVerification.ok) {
    throw new Error(
      `Backup verification failed: pipeline="${verification.integrity}", news="${newsVerification.integrity}"` +
        (verification.mismatches.length > 0 ? `, pipeline mismatches=${verification.mismatches.join('; ')}` : '') +
        (newsVerification.mismatches.length > 0 ? `, news mismatches=${newsVerification.mismatches.join('; ')}` : '')
    )
  }
}

async function main(): Promise<void> {
  await runOnce()
}

main().catch((err) => {
  console.error('[pipeline-backup] fatal:', err)
  process.exit(1)
})
