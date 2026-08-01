import { loadDotenvChain } from '../pipeline-store/cli-env'

loadDotenvChain()

import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { promisify } from 'node:util'
import { defaultLast30DaysScriptPath } from './researcher'
import { fetchPolymarketNativeContext } from './market-context'
import { SqlitePipelineStore } from '../pipeline-store/sqlite-store'

const execFileAsync = promisify(execFile)

interface CheckResult {
  name: string
  ok: boolean
  detail: string
}

function envString(name: string, fallback = ''): string {
  const value = process.env[name]?.trim()
  return value || fallback
}

function requiredEnv(name: string): CheckResult {
  return {
    name: `env:${name}`,
    ok: Boolean(process.env[name]?.trim()),
    detail: process.env[name]?.trim() ? 'present' : 'missing',
  }
}

async function checkCommand(command: string, args: string[], timeoutMs: number): Promise<{ stdout: string, stderr: string }> {
  return execFileAsync(command, args, {
    timeout: timeoutMs,
    maxBuffer: 5 * 1024 * 1024,
    env: { ...process.env },
  })
}

async function runCheck(name: string, fn: () => Promise<string>): Promise<CheckResult> {
  try {
    return { name, ok: true, detail: await fn() }
  } catch (error) {
    return {
      name,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

async function main(): Promise<void> {
  const hermesCommand = 'hermes'
  const hermesTimeoutMs = 60_000
  const last30DaysPython = 'python3.12'
  const last30DaysScript = defaultLast30DaysScriptPath()
  const slug = envString('POLYMARKET_DOCTOR_SLUG', 'will-the-fed-increase-interest-rates-by-25-bps-after-the-july-2026-meeting')

  const results: CheckResult[] = [
    requiredEnv('SUPABASE_URL'),
    requiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
  ]

  results.push(await runCheck('local_pipeline_store:candidates:read', async () => {
    // polymarket_market_candidates now lives in the local SQLite pipeline
    // store, not Supabase (Supabase's copy is empty post-migration) - do a
    // cheap read against the same store the researcher/data-engineer use.
    const store = new SqlitePipelineStore()
    try {
      await store.fetchPendingCandidates({ source: 'polymarket', area: 'markets', limit: 1 })
      return 'read ok'
    } finally {
      store.close()
    }
  }))

  results.push(await runCheck('local_pipeline_store:candidate_research:read', async () => {
    // polymarket_market_candidate_research likewise moved to the local
    // pipeline store.
    const store = new SqlitePipelineStore()
    try {
      await store.fetchResearchByStatus({ source: 'polymarket', area: 'markets', status: 'pending_editor', limit: 1 })
      return 'read ok'
    } finally {
      store.close()
    }
  }))

  results.push(await runCheck('polymarket:gamma_api', async () => {
    const context = await fetchPolymarketNativeContext(slug)
    return `fetched ${context.market.slug}`
  }))

  results.push(await runCheck('hermes:version', async () => {
    const { stdout } = await checkCommand(hermesCommand, ['--version'], 15_000)
    return stdout.trim() || 'available'
  }))

  results.push(await runCheck('hermes:planner_json', async () => {
    const args = ['--ignore-rules']
    args.push('-z', 'Return strict JSON only: {"ok": true}')

    const { stdout } = await checkCommand(
      hermesCommand,
      args,
      hermesTimeoutMs
    )
    const parsed = JSON.parse(stdout.trim()) as { ok?: unknown }
    if (parsed.ok !== true) throw new Error(`unexpected output: ${stdout.slice(0, 500)}`)
    return 'strict JSON ok'
  }))

  results.push(await runCheck('last30days:python', async () => {
    const { stdout } = await checkCommand(last30DaysPython, ['--version'], 15_000)
    return stdout.trim() || 'python available'
  }))

  results.push(await runCheck('last30days:script_exists', async () => {
    await access(last30DaysScript)
    return last30DaysScript
  }))

  results.push(await runCheck('last30days:help', async () => {
    await checkCommand(last30DaysPython, [last30DaysScript, '--help'], 30_000)
    return 'help ok'
  }))

  const ok = results.every((result) => result.ok)
  console.log(JSON.stringify({
    ok,
    mode: 'polymarket_collector_researcher_doctor',
    checks: results,
  }, null, 2))

  if (!ok) process.exit(1)
}

main().catch((error) => {
  console.error('[polymarket-doctor] fatal:', error)
  process.exit(1)
})
