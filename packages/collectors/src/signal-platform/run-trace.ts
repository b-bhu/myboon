import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

import { loadDotenvChain } from '../pipeline-store/cli-env'
import {
  CanonicalTraceInspector,
  formatTraceInspectionJson,
  type TraceInspectionQuery,
} from './operator-trace'
import { SqliteBoundedExecutionTraceReader } from './operator-trace-sqlite'
import { SqliteSignalPlatformStore } from './sqlite-platform-store'

loadDotenvChain()

const PACKAGE_DIR = resolve(__dirname, '..', '..')

function databasePath(value: string | undefined, fallback: string): string {
  const configured = value?.trim() || fallback
  return isAbsolute(configured) ? configured : resolve(PACKAGE_DIR, configured)
}

async function main(): Promise<void> {
  const query = parseQuery(process.argv.slice(2))
  const newsPath = databasePath(process.env.NEWS_SQLITE_PATH, '.data/news.sqlite')
  const pipelinePath = databasePath(process.env.PIPELINE_SQLITE_PATH, '.data/pipeline.sqlite')
  for (const [source, path] of [['news', newsPath], ['polymarket', pipelinePath]] as const) {
    if (!existsSync(path)) throw new Error(`${source} SQLite database does not exist at configured path`)
  }
  const stores = [
    new SqliteSignalPlatformStore(newsPath, 'news', { readOnly: true }),
    new SqliteSignalPlatformStore(pipelinePath, 'polymarket', { readOnly: true }),
  ]
  const readers = [
    new SqliteBoundedExecutionTraceReader(newsPath, 'news'),
    new SqliteBoundedExecutionTraceReader(pipelinePath, 'polymarket'),
  ]
  try {
    const result = await new CanonicalTraceInspector({ stores, executionReaders: readers })
      .inspect(query, { now: new Date().toISOString() })
    process.stdout.write(`${formatTraceInspectionJson(result)}\n`)
  } finally {
    for (const reader of readers) reader.close()
    for (const store of stores) store.close()
  }
}

function parseQuery(args: string[]): TraceInspectionQuery {
  const values: Partial<Record<'signalId' | 'workId' | 'packetId', string>> = {}
  const flags = new Map<string, 'signalId' | 'workId' | 'packetId'>([
    ['--signal-id', 'signalId'],
    ['--work-id', 'workId'],
    ['--packet-id', 'packetId'],
  ] as const)
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    const key = flag ? flags.get(flag) : undefined
    const value = args[index + 1]
    if (!key) throw new Error(`Unknown trace argument: ${flag ?? ''}`)
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
    values[key] = value
  }
  const present = Object.entries(values)
  if (present.length !== 1) throw new Error('Use exactly one of --signal-id, --work-id, or --packet-id')
  if (values.signalId) return { signalId: values.signalId }
  if (values.workId) return { workId: values.workId }
  if (values.packetId) return { packetId: values.packetId }
  throw new Error('Trace identity is required')
}

main().catch((error) => {
  process.stderr.write(`[feed-v3-trace] ${error instanceof Error ? error.message : 'unknown failure'}\n`)
  process.exitCode = 1
})
