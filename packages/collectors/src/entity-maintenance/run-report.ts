import { createClient } from '@supabase/supabase-js'
import { loadDotenvChain, positiveInteger, requiredEnv } from '../pipeline-store/cli-env'

interface MaintenanceRunRow {
  id: string
  trigger_kind: string
  mode: string
  scope: string
  status: string
  provider: string
  model: string
  prompt_version: string
  catalog_count: number
  candidate_count: number
  reviewed_count: number
  merge_proposal_count: number
  alias_quarantine_count: number
  uncertain_count: number
  summary: Record<string, unknown>
  error: string | null
  started_at: string
  finished_at: string | null
}

interface MaintenanceFindingRow {
  id: string
  pair_key: string
  decision: string
  recommended_action: string
  confidence: number
  canonical_entity_id: string | null
  polluted_entity_id: string | null
  polluted_alias: string | null
  reason: string
  auto_apply_eligible: boolean
  review_status: string
  profile_snapshot: unknown
}

async function main(): Promise<void> {
  loadDotenvChain()
  const db = createClient(requiredEnv('SUPABASE_URL'), requiredEnv('SUPABASE_SERVICE_ROLE_KEY'))
  const requestedRunId = process.env.ENTITY_CATALOG_MAINTENANCE_REPORT_RUN_ID?.trim()
  const limit = positiveInteger(process.env.ENTITY_CATALOG_MAINTENANCE_REPORT_LIMIT, 100)
  let runQuery = db
    .from('entity_catalog_maintenance_runs')
    .select('id, trigger_kind, mode, scope, status, provider, model, prompt_version, catalog_count, candidate_count, reviewed_count, merge_proposal_count, alias_quarantine_count, uncertain_count, summary, error, started_at, finished_at')
  runQuery = requestedRunId ? runQuery.eq('id', requestedRunId) : runQuery.order('started_at', { ascending: false }).limit(1)
  const { data: runs, error: runError } = await runQuery
  if (runError) throw new Error(`Entity maintenance report run lookup failed: ${runError.message}`)
  const run = (runs?.[0] ?? null) as MaintenanceRunRow | null
  if (!run) {
    console.log(JSON.stringify({ report: 'entity_catalog_maintenance', run: null, findings: [] }, null, 2))
    return
  }

  const { data: findings, error: findingError } = await db
    .from('entity_catalog_maintenance_findings')
    .select('id, pair_key, decision, recommended_action, confidence, canonical_entity_id, polluted_entity_id, polluted_alias, reason, auto_apply_eligible, review_status, profile_snapshot')
    .eq('run_id', run.id)
    .order('confidence', { ascending: false })
    .limit(limit)
  if (findingError) throw new Error(`Entity maintenance report finding lookup failed: ${findingError.message}`)

  console.log(JSON.stringify({
    report: 'entity_catalog_maintenance',
    run,
    findings: ((findings ?? []) as MaintenanceFindingRow[]).map(compactFinding),
  }, null, 2))
}

function compactFinding(finding: MaintenanceFindingRow): Record<string, unknown> {
  const snapshot = record(finding.profile_snapshot)
  return {
    id: finding.id,
    pairKey: finding.pair_key,
    decision: finding.decision,
    recommendedAction: finding.recommended_action,
    confidence: finding.confidence,
    canonicalEntityId: finding.canonical_entity_id,
    pollutedEntityId: finding.polluted_entity_id,
    pollutedAlias: finding.polluted_alias,
    reason: finding.reason,
    autoApplyEligible: finding.auto_apply_eligible,
    reviewStatus: finding.review_status,
    left: compactEntity(record(snapshot.left)),
    right: compactEntity(record(snapshot.right)),
  }
}

function compactEntity(profile: Record<string, unknown>): Record<string, unknown> {
  return {
    id: profile.id ?? null,
    name: profile.name ?? null,
    slug: profile.slug ?? null,
    type: profile.type ?? null,
    aliases: Array.isArray(profile.aliases) ? profile.aliases : [],
    memoryCount: profile.memoryCount ?? 0,
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

if (require.main === module || process.env.NODE_APP_INSTANCE !== undefined) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
