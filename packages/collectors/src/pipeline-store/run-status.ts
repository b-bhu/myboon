import { loadDotenvChain } from './cli-env'

loadDotenvChain()

import { SqlitePipelineStore } from './sqlite-store'
import { buildPipelineStatusReport } from './status'
import { SqliteNewsStore } from '../news/sqlite-store'

/**
 * CLI: `pnpm pipeline-store:status`
 *
 * Prints a JSON backlog/status report to stdout for the pipeline's
 * (source, area) pairs. This is the replacement for the Supabase dashboard
 * issue #256 removed - see status.ts for why it exists.
 *
 * By default reports on polymarket/markets, the pipeline this rebuild
 * targets. Additional pairs can be requested via PIPELINE_STATUS_AREAS,
 * formatted as "source:area,source:area" (e.g. "polymarket:markets,news:articles").
 */
function parseAreas(raw: string | undefined): Array<{ source: string; area: string }> {
  const fallback = [{ source: 'polymarket', area: 'markets' }]
  if (!raw || !raw.trim()) return fallback

  const parsed = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [source, area] = entry.split(':').map((part) => part.trim())
      return source && area ? { source, area } : null
    })
    .filter((entry): entry is { source: string; area: string } => entry !== null)

  return parsed.length > 0 ? parsed : fallback
}

async function main(): Promise<void> {
  const sqlitePath = process.env.PIPELINE_SQLITE_PATH
  const newsSqlitePath = process.env.NEWS_SQLITE_PATH
  const areas = parseAreas(process.env.PIPELINE_STATUS_AREAS)

  const store = new SqlitePipelineStore(sqlitePath)
  const newsStore = new SqliteNewsStore(newsSqlitePath)
  try {
    const pipeline = await buildPipelineStatusReport(store, areas)
    console.log(JSON.stringify({
      generatedAt: pipeline.generatedAt,
      pipeline: pipeline.areas,
      news: newsStore.getOperationalStatus(),
    }, null, 2))
  } finally {
    store.close()
    newsStore.close()
  }
}

main().catch((error) => {
  console.error('[pipeline-status] fatal:', error)
  process.exit(1)
})
