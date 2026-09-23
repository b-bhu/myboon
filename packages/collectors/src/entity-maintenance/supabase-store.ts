import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  BeginEntityMaintenanceRunInput,
  CompleteEntityMaintenanceRunInput,
  EntityCatalogMaintenanceScope,
  EntityCatalogMaintenanceStore,
  EntityCatalogProfile,
  EntityCatalogRecentMemory,
  EntityMaintenanceFindingInput,
  EntityMaintenanceRunRecord,
} from './contracts'

const RUN_TABLE = 'entity_catalog_maintenance_runs'
const FINDING_TABLE = 'entity_catalog_maintenance_findings'
const PROFILE_PAGE_SIZE = 500

export class SupabaseEntityCatalogMaintenanceStore implements EntityCatalogMaintenanceStore {
  constructor(
    private readonly db: SupabaseClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async beginRun(input: BeginEntityMaintenanceRunInput): Promise<EntityMaintenanceRunRecord> {
    const now = this.now()
    const nowIso = now.toISOString()
    const stale = await this.db
      .from(RUN_TABLE)
      .update({
        status: 'failed',
        error: 'Run lease expired before completion.',
        finished_at: nowIso,
        updated_at: nowIso,
      })
      .eq('status', 'running')
      .lt('lease_expires_at', nowIso)
    if (stale.error) throw new Error(`Entity maintenance stale-run recovery failed: ${stale.error.message}`)

    const leaseExpiresAt = new Date(now.getTime() + input.leaseMs).toISOString()
    const { data, error } = await this.db
      .from(RUN_TABLE)
      .insert({
        trigger_kind: input.trigger,
        mode: input.mode,
        scope: input.scope,
        status: 'running',
        provider: input.provider,
        model: input.model,
        prompt_version: input.promptVersion,
        heartbeat_at: nowIso,
        lease_expires_at: leaseExpiresAt,
        started_at: nowIso,
        updated_at: nowIso,
      })
      .select('id, status')
      .single()
    if (error) throw new Error(`Entity maintenance run claim failed: ${error.message}`)
    return { id: requiredText(data?.id, 'run.id'), status: runStatus(data?.status) }
  }

  async heartbeatRun(runId: string, leaseMs: number): Promise<void> {
    const now = this.now()
    const { data, error } = await this.db
      .from(RUN_TABLE)
      .update({
        heartbeat_at: now.toISOString(),
        lease_expires_at: new Date(now.getTime() + leaseMs).toISOString(),
        updated_at: now.toISOString(),
      })
      .eq('id', runId)
      .eq('status', 'running')
      .select('id')
      .maybeSingle()
    if (error) throw new Error(`Entity maintenance heartbeat failed: ${error.message}`)
    if (!data) throw new Error(`Entity maintenance run ${runId} no longer owns the active lease.`)
  }

  async hasCompletedFullCatalogRun(): Promise<boolean> {
    const { data, error } = await this.db
      .from(RUN_TABLE)
      .select('id')
      .eq('scope', 'full_catalog')
      .eq('status', 'completed')
      .limit(1)
      .maybeSingle()
    if (error) throw new Error(`Entity maintenance full-baseline lookup failed: ${error.message}`)
    return data !== null
  }

  async latestCompletedRun(): Promise<{ startedAt: string } | null> {
    const { data, error } = await this.db
      .from(RUN_TABLE)
      .select('started_at')
      // A partial run must not advance the incremental watermark; otherwise
      // unchanged candidates from its failed batches would never be retried.
      .eq('status', 'completed')
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw new Error(`Entity maintenance latest-run lookup failed: ${error.message}`)
    return data ? { startedAt: timestamp(data.started_at, 'run.started_at') } : null
  }

  async listProfiles(
    _scope: EntityCatalogMaintenanceScope,
    _changedSince?: string,
  ): Promise<EntityCatalogProfile[]> {
    // The catalogue is deliberately hydrated in full. Incremental mode limits
    // candidate inference in the service while retaining existing Entities as
    // possible matches for every changed Entity.
    const output: EntityCatalogProfile[] = []
    let afterId: string | null = null
    while (true) {
      const result = await this.db.rpc('internal_entity_catalog_profiles_v1', {
        p_after_id: afterId,
        p_limit: PROFILE_PAGE_SIZE,
      }) as unknown as { data: unknown, error: { message: string } | null }
      if (result.error) throw new Error(`Entity catalogue profile read failed: ${result.error.message}`)
      if (!Array.isArray(result.data)) throw new Error('Entity catalogue profile read returned a non-array payload.')
      const page: EntityCatalogProfile[] = result.data.map((row, index) => normalizeProfile(row, output.length + index))
      output.push(...page)
      if (page.length < PROFILE_PAGE_SIZE) break
      const nextAfterId: string | undefined = page.at(-1)?.id
      if (!nextAfterId || nextAfterId === afterId) throw new Error('Entity catalogue profile pagination did not advance.')
      afterId = nextAfterId
    }
    return output
  }

  async saveFindings(findings: readonly EntityMaintenanceFindingInput[]): Promise<void> {
    if (findings.length === 0) return
    const nowIso = this.now().toISOString()
    const { error } = await this.db.from(FINDING_TABLE).insert(findings.map((finding) => ({
      run_id: finding.runId,
      pair_key: finding.pairKey,
      left_entity_id: finding.leftEntityId,
      right_entity_id: finding.rightEntityId,
      decision: finding.decision,
      recommended_action: finding.recommendedAction,
      confidence: finding.confidence,
      canonical_entity_id: finding.canonicalEntityId,
      polluted_entity_id: finding.pollutedEntityId,
      polluted_alias: finding.pollutedAlias,
      reason: finding.reason,
      candidate_signals: finding.candidateSignals,
      profile_snapshot: finding.profileSnapshot,
      auto_apply_eligible: finding.autoApplyEligible,
      updated_at: nowIso,
    })))
    if (error) throw new Error(`Entity maintenance finding write failed: ${error.message}`)
  }

  async completeRun(runId: string, input: CompleteEntityMaintenanceRunInput): Promise<void> {
    const nowIso = this.now().toISOString()
    const { data, error } = await this.db
      .from(RUN_TABLE)
      .update({
        status: input.status,
        catalog_count: input.catalogCount,
        candidate_count: input.candidateCount,
        reviewed_count: input.reviewedCount,
        merge_proposal_count: input.mergeProposalCount,
        alias_quarantine_count: input.aliasQuarantineCount,
        uncertain_count: input.uncertainCount,
        summary: input.summary,
        error: null,
        heartbeat_at: nowIso,
        finished_at: nowIso,
        updated_at: nowIso,
      })
      .eq('id', runId)
      .eq('status', 'running')
      .select('id')
      .maybeSingle()
    if (error) throw new Error(`Entity maintenance run completion failed: ${error.message}`)
    if (!data) throw new Error(`Entity maintenance run ${runId} was not running at completion.`)
  }

  async failRun(runId: string, errorMessage: string): Promise<void> {
    const nowIso = this.now().toISOString()
    const { error } = await this.db
      .from(RUN_TABLE)
      .update({
        status: 'failed',
        error: errorMessage,
        heartbeat_at: nowIso,
        finished_at: nowIso,
        updated_at: nowIso,
      })
      .eq('id', runId)
      .eq('status', 'running')
    if (error) throw new Error(`Entity maintenance failure recording failed: ${error.message}`)
  }
}

function normalizeProfile(value: unknown, index: number): EntityCatalogProfile {
  const row = record(value, `profile[${index}]`)
  return {
    id: requiredText(row.id, `profile[${index}].id`),
    slug: requiredText(row.slug, `profile[${index}].slug`),
    name: requiredText(row.name, `profile[${index}].name`),
    type: requiredText(row.type, `profile[${index}].type`),
    aliases: textArray(row.aliases),
    summary: nullableText(row.summary),
    status: requiredText(row.status, `profile[${index}].status`),
    showInCarousel: row.show_in_carousel === true,
    tags: textArray(row.tags),
    createdAt: timestamp(row.created_at, `profile[${index}].created_at`),
    updatedAt: timestamp(row.updated_at, `profile[${index}].updated_at`),
    changedAt: timestamp(row.changed_at, `profile[${index}].changed_at`),
    memoryCount: nonNegativeInteger(row.memory_count, `profile[${index}].memory_count`),
    sourceCount: nonNegativeInteger(row.source_count, `profile[${index}].source_count`),
    firstMemoryAt: nullableTimestamp(row.first_memory_at, `profile[${index}].first_memory_at`),
    lastMemoryAt: nullableTimestamp(row.last_memory_at, `profile[${index}].last_memory_at`),
    recentMemories: recentMemories(row.recent_memories, index),
  }
}

function recentMemories(value: unknown, profileIndex: number): EntityCatalogRecentMemory[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 5).map((item, index) => {
    const row = record(item, `profile[${profileIndex}].recentMemories[${index}]`)
    return {
      title: requiredText(row.title, `profile[${profileIndex}].recentMemories[${index}].title`),
      memoryType: requiredText(row.memoryType, `profile[${profileIndex}].recentMemories[${index}].memoryType`),
      source: requiredText(row.source, `profile[${profileIndex}].recentMemories[${index}].source`),
      observedAt: timestamp(row.observedAt, `profile[${profileIndex}].recentMemories[${index}].observedAt`),
    }
  })
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object.`)
  return value as Record<string, unknown>
}

function textArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))]
    : []
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} must be non-empty text.`)
  return value.trim()
}

function nullableText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function timestamp(value: unknown, field: string): string {
  const text = requiredText(value, field)
  const parsed = new Date(text)
  if (Number.isNaN(parsed.getTime())) throw new Error(`${field} must be a timestamp.`)
  return parsed.toISOString()
}

function nullableTimestamp(value: unknown, field: string): string | null {
  return value === null || value === undefined ? null : timestamp(value, field)
}

function nonNegativeInteger(value: unknown, field: string): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${field} must be a non-negative integer.`)
  return parsed
}

function runStatus(value: unknown): EntityMaintenanceRunRecord['status'] {
  if (value === 'running' || value === 'completed' || value === 'partial' || value === 'failed') return value
  throw new Error('run.status is invalid.')
}
