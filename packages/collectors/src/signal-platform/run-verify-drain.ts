import { isAbsolute, resolve } from 'node:path'

import { packageScriptArgs } from '../cli-args'
import { loadDotenvChain } from '../pipeline-store/cli-env'
import { readEntityRuntimeHealthSnapshot } from '../entity-manager/entity-runtime-health'
import { readResearchRuntimeStatusSnapshot } from '../research-engine/research-runtime-lifecycle'
import { parseDrainVerificationArgs, verifyDrainState } from './drain-verification'
import { FileRuntimeControlStore, resolveRuntimeControlPath } from './runtime-control'
import { readSqliteControlPlaneStatus } from './status-sqlite-composition'
import { resolveSqliteWriteHealthJournalPath } from './sqlite-write-error-journal'

loadDotenvChain()
const PACKAGE_DIR = resolve(__dirname, '..', '..')

async function main(): Promise<void> {
  const command = parseDrainVerificationArgs(packageScriptArgs(process.argv.slice(2)))
  const startedAt = Date.now()
  let report: ReturnType<typeof verifyDrainState>
  do {
    report = await inspect(command)
    if (report.passed || Date.now() - startedAt >= command.timeoutMs) break
    await new Promise((resolveWait) => setTimeout(resolveWait, command.pollMs))
  } while (true)
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (!report.passed) process.exitCode = 2
}

async function inspect(command: ReturnType<typeof parseDrainVerificationArgs>) {
  const generatedAt = new Date().toISOString()
  const newsPath = databasePath(process.env.NEWS_SQLITE_PATH, '.data/news.sqlite')
  const pipelinePath = databasePath(process.env.PIPELINE_SQLITE_PATH, '.data/pipeline.sqlite')
  const staleAfterMs = positiveInteger(process.env.FEED_V3_DRAIN_STATUS_STALE_MS, 60_000)
  const [status, researchRuntime, entityRuntime] = await Promise.all([
    readSqliteControlPlaneStatus({
      newsPath, pipelinePath, now: generatedAt,
      writeHealthJournalPath: resolveSqliteWriteHealthJournalPath(process.env, PACKAGE_DIR),
    }),
    readResearchRuntimeStatusSnapshot({
      path: databasePath(process.env.FEED_V3_RESEARCH_RUNTIME_STATUS_PATH, '.data/feed-v3-research-runtime-status.json'),
      staleAfterMs,
    }),
    readEntityRuntimeHealthSnapshot({
      path: databasePath(process.env.FEED_V3_ENTITY_RUNTIME_STATUS_PATH, '.data/feed-v3-entity-runtime-status.json'),
      staleAfterMs,
    }),
  ])
  const control = new FileRuntimeControlStore(resolveRuntimeControlPath(process.env)).read()
  return verifyDrainState({
    generatedAt, stage: command.stage, operationId: command.operationId,
    sources: command.sources, control, status, runtime: { researchRuntime, entityRuntime },
  })
}

function databasePath(value: string | undefined, fallback: string): string {
  const configured = value?.trim() || fallback
  return isAbsolute(configured) ? resolve(configured) : resolve(PACKAGE_DIR, configured)
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error('FEED_V3_DRAIN_STATUS_STALE_MS must be positive')
  return parsed
}

main().catch((error) => {
  process.stderr.write(`[feed-v3-verify-drain] ${error instanceof Error ? error.message : 'unknown failure'}\n`)
  process.exitCode = 1
})
