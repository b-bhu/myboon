import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { packageScriptArgs } from '../cli-args'
import { backupNewsStore, backupPipelineStore, verifyNewsBackup, verifyPipelineBackup } from '../pipeline-store/backup'
import { loadDotenvChain } from '../pipeline-store/cli-env'
import { resolveLaneSqlitePathFromEnv } from '../lane-store/paths'
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

async function main(): Promise<void> {
  const args = packageScriptArgs(process.argv.slice(2))
  const unknown = args.filter((arg) => arg !== '--apply' && arg !== '--close-all')
  if (unknown.length) throw new Error(`Unknown arguments: ${unknown.join(' ')} (accepted: --apply, --close-all)`)
  const apply = args.includes('--apply')
  const closeAll = args.includes('--close-all')
  const now = new Date().toISOString()
  const sources = [
    ['news', resolveLaneSqlitePathFromEnv('news', process.env, { baseDir: PACKAGE_DIR })],
    ['polymarket', resolveLaneSqlitePathFromEnv('polymarket', process.env, { baseDir: PACKAGE_DIR })],
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
        store, apply, closeAll, now, providerHealth: runtime.triageProviderHealth, allowedDepths: [...runtime.triageAllowedDepths],
      }))
    } finally { store.close() }
  }
  process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`)
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'held backlog release failed'}\n`)
  process.exitCode = 1
})
