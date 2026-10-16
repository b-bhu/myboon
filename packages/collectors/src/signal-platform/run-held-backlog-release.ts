import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { packageScriptArgs } from '../cli-args'
import { backupNewsStore, backupPipelineStore, verifyNewsBackup, verifyPipelineBackup } from '../pipeline-store/backup'
import { loadDotenvChain } from '../pipeline-store/cli-env'
import { releaseHeldBacklog, type HeldBacklogReport } from './held-backlog-release'
import { loadFeedV3RuntimeConfig } from './runtime-config'
import { SqliteSignalPlatformStore } from './sqlite-platform-store'

/**
 * #339 one-shot backlog release. Dry-run by default (read-only stores, writes
 * nothing). `--apply` takes a verified backup first, then closes/releases.
 * Real runs need the systems manager's go.
 */
loadDotenvChain()
const PACKAGE_DIR = resolve(__dirname, '..', '..')

function databasePath(value: string | undefined, fallback: string): string {
  const configured = value?.trim() || fallback
  return isAbsolute(configured) ? configured : resolve(PACKAGE_DIR, configured)
}

async function main(): Promise<void> {
  const args = packageScriptArgs(process.argv.slice(2))
  const unknown = args.filter((arg) => arg !== '--apply')
  if (unknown.length) throw new Error(`Unknown arguments: ${unknown.join(' ')} (only --apply is accepted)`)
  const apply = args.includes('--apply')
  const now = new Date().toISOString()
  const sources = [
    ['news', databasePath(process.env.NEWS_SQLITE_PATH, '.data/news.sqlite')],
    ['polymarket', databasePath(process.env.PIPELINE_SQLITE_PATH, '.data/pipeline.sqlite')],
  ] as const
  for (const [source, path] of sources) if (!existsSync(path)) throw new Error(`${source} SQLite database does not exist at configured path`)
  if (apply) {
    const news = await backupNewsStore({ sourcePath: sources[0][1], now })
    if (!(await verifyNewsBackup(news.path, news.sourceTableCounts)).ok) throw new Error('Verified news backup failed')
    const pipeline = await backupPipelineStore({ sourcePath: sources[1][1], now })
    if (!(await verifyPipelineBackup(pipeline.path, pipeline.sourceTableCounts)).ok) throw new Error('Verified pipeline backup failed')
  }
  const runtime = loadFeedV3RuntimeConfig()
  const reports: HeldBacklogReport[] = []
  for (const [source, path] of sources) {
    const store = new SqliteSignalPlatformStore(path, source, { readOnly: !apply })
    try {
      reports.push(await releaseHeldBacklog({
        store, apply, now, providerHealth: runtime.triageProviderHealth, allowedDepths: [...runtime.triageAllowedDepths],
      }))
    } finally { store.close() }
  }
  process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`)
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'held backlog release failed'}\n`)
  process.exitCode = 1
})
