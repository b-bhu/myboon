import { isAbsolute, resolve } from 'node:path'
import { loadDotenvChain } from '../pipeline-store/cli-env'
import {
  formatRetentionPreviewJson,
  previewSqliteRetention,
  type RetentionDatabaseKind,
} from './retention-preview'

export interface RetentionPreviewCliCommand {
  store: RetentionDatabaseKind | 'both'
  before: string
  sampleLimit: number
  newsPath?: string
  pipelinePath?: string
  deepRegistryPath?: string
}

export function parseRetentionPreviewArgs(argv: string[]): RetentionPreviewCliCommand {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!flag?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`Expected --flag value near ${flag ?? '<end>'}`)
    }
    if (values.has(flag)) throw new Error(`Duplicate argument: ${flag}`)
    values.set(flag, value)
  }
  const allowed = new Set(['--store', '--before', '--limit', '--news-db', '--pipeline-db', '--deep-registry'])
  for (const flag of values.keys()) if (!allowed.has(flag)) throw new Error(`Unknown argument: ${flag}`)
  const before = values.get('--before')?.trim()
  if (!before || !Number.isFinite(Date.parse(before))) throw new Error('--before is required and must be a timestamp')
  const store = values.get('--store')?.trim() ?? 'both'
  if (store !== 'news' && store !== 'pipeline' && store !== 'both') {
    throw new Error('--store must be news, pipeline, or both')
  }
  const sampleLimit = Number(values.get('--limit') ?? 25)
  if (!Number.isSafeInteger(sampleLimit) || sampleLimit < 1 || sampleLimit > 500) {
    throw new Error('--limit must be an integer between 1 and 500')
  }
  return {
    store,
    before,
    sampleLimit,
    ...(values.get('--news-db') ? { newsPath: values.get('--news-db') } : {}),
    ...(values.get('--pipeline-db') ? { pipelinePath: values.get('--pipeline-db') } : {}),
    ...(values.get('--deep-registry') ? { deepRegistryPath: values.get('--deep-registry') } : {}),
  }
}

function pathFrom(value: string | undefined, fallback: string): string {
  const selected = value?.trim() || fallback
  return isAbsolute(selected) ? selected : resolve(__dirname, '..', '..', selected)
}

export function runRetentionPreviewCli(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  now = new Date(),
): string {
  const command = parseRetentionPreviewArgs(argv)
  const newsPath = pathFrom(command.newsPath ?? env.NEWS_SQLITE_PATH, '.data/news.sqlite')
  const pipelinePath = pathFrom(command.pipelinePath ?? env.PIPELINE_SQLITE_PATH, '.data/pipeline.sqlite')
  const deepRegistryPath = pathFrom(
    command.deepRegistryPath ?? env.DEEP_RESEARCH_REGISTRY_PATH,
    '.data/deep-research-registry.sqlite',
  )
  const databases = command.store === 'both'
    ? [{ database: 'news' as const, path: newsPath }, { database: 'pipeline' as const, path: pipelinePath }]
    : [{ database: command.store, path: command.store === 'news' ? newsPath : pipelinePath }]
  return formatRetentionPreviewJson(previewSqliteRetention({
    before: command.before,
    sampleLimit: command.sampleLimit,
    databases,
    deepRegistryPath,
    generatedAt: now.toISOString(),
  }))
}

if (require.main === module) {
  loadDotenvChain()
  try {
    process.stdout.write(`${runRetentionPreviewCli(process.argv.slice(2))}\n`)
  } catch (error) {
    process.stderr.write(`[feed-v3-retention-preview] ${error instanceof Error ? error.message : 'unknown failure'}\n`)
    process.exitCode = 1
  }
}
