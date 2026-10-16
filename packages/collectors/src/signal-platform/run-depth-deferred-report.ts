import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { loadDotenvChain } from '../pipeline-store/cli-env'
import { SqliteSignalPlatformStore } from './sqlite-platform-store'

/** #339 read-only count of signals held by the retired unsupported-depth rule. Writes nothing. */
loadDotenvChain()
const PACKAGE_DIR = resolve(__dirname, '..', '..')

function databasePath(value: string | undefined, fallback: string): string {
  const configured = value?.trim() || fallback
  return isAbsolute(configured) ? configured : resolve(PACKAGE_DIR, configured)
}

const sources = [
  ['news', databasePath(process.env.NEWS_SQLITE_PATH, '.data/news.sqlite')],
  ['polymarket', databasePath(process.env.PIPELINE_SQLITE_PATH, '.data/pipeline.sqlite')],
] as const
const report: Record<string, unknown> = {}
for (const [source, path] of sources) {
  if (!existsSync(path)) { report[source] = { error: 'database not found' }; continue }
  const store = new SqliteSignalPlatformStore(path, source, { readOnly: true })
  try { report[source] = store.depthDeferredBacklog() } finally { store.close() }
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
