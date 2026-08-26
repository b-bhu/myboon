import { loadDotenvChain } from './cli-env'

loadDotenvChain()

import { readAllDeadLetterCounts } from './failure-recovery'

function main(): void {
  const rows = readAllDeadLetterCounts({
    pipelineSqlitePath: process.env.PIPELINE_SQLITE_PATH,
    newsSqlitePath: process.env.NEWS_SQLITE_PATH,
  })
  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    total: rows.reduce((sum, row) => sum + row.count, 0),
    queues: rows,
  }, null, 2))
}

try {
  main()
} catch (error) {
  console.error('[pipeline-dead-letter-status] fatal:', error instanceof Error ? error.message : String(error))
  process.exit(1)
}
