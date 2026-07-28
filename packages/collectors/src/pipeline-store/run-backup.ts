import { config as loadEnv } from 'dotenv'

loadEnv({ path: '.env' })
loadEnv({ path: '../../.env' })
loadEnv()

import { backupPipelineStore, pruneOldBackups, verifyPipelineBackup } from './backup'

async function runOnce(): Promise<void> {
  const sourcePath = process.env.PIPELINE_SQLITE_PATH
  const backupDir = process.env.PIPELINE_BACKUP_DIR
  const keepRaw = process.env.PIPELINE_BACKUP_KEEP
  const keep = keepRaw ? Number(keepRaw) : undefined

  const backupResult = await backupPipelineStore({ sourcePath, backupDir })
  const verification = await verifyPipelineBackup(backupResult.path, backupResult.tableCounts)
  const deletedBackups = await pruneOldBackups({
    backupDir,
    keep: Number.isFinite(keep) ? keep : undefined,
  })

  const summary = {
    backup: backupResult,
    verification,
    pruned: deletedBackups,
  }
  console.log(JSON.stringify(summary, null, 2))

  if (!verification.ok) {
    throw new Error(
      `Backup verification failed: integrity="${verification.integrity}"` +
        (verification.mismatches.length > 0 ? `, mismatches=${verification.mismatches.join('; ')}` : '')
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
