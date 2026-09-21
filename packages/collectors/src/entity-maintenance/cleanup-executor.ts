import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  EntityCatalogCleanupExecutor,
  EntityCatalogCleanupResult,
  EntityMaintenanceFindingInput,
} from './contracts'

export interface EntityDraftInventory {
  count(entityId: string): Promise<number>
}

export class SupabaseEntityCatalogCleanupExecutor implements EntityCatalogCleanupExecutor {
  constructor(
    private readonly db: SupabaseClient,
    private readonly drafts: EntityDraftInventory,
    private readonly actor = 'entity-catalog-maintenance',
  ) {}

  async applyEligible(
    runId: string,
    findings: readonly EntityMaintenanceFindingInput[],
  ): Promise<EntityCatalogCleanupResult> {
    const result: EntityCatalogCleanupResult = {
      mutationCount: 0,
      aliasQuarantineCount: 0,
      mergeCount: 0,
      skipped: [],
      errors: [],
    }

    const eligible = findings.filter((candidate) => candidate.autoApplyEligible)
    const idsByPair = await this.findingIds(runId, eligible.map((finding) => finding.pairKey))
    for (const finding of eligible) {
      const id = idsByPair.get(finding.pairKey)
      if (!id) {
        result.errors.push({ findingId: finding.pairKey, error: 'persisted_finding_not_found' })
        continue
      }
      try {
        if (finding.recommendedAction === 'quarantine_alias') {
          // Alias meaning is contextual, so the scheduled model never gets
          // deletion authority. Reviewed alias quarantines use the existing
          // operator-only command and remain exactly reversible.
          result.skipped.push({ findingId: id, reason: 'alias_requires_explicit_review' })
          continue
        }

        if (finding.recommendedAction !== 'merge' || !finding.canonicalEntityId) {
          result.skipped.push({ findingId: id, reason: 'unsupported_auto_action' })
          continue
        }
        const sourceEntityId = finding.leftEntityId === finding.canonicalEntityId
          ? finding.rightEntityId
          : finding.leftEntityId
        const draftCount = await this.drafts.count(sourceEntityId)
        if (draftCount > 0) {
          result.skipped.push({
            findingId: id,
            reason: `local_draft_inventory_not_empty:${draftCount}`,
          })
          continue
        }
        await this.rpc('entity_catalog_apply_merge_v1', {
          p_finding_id: id,
          p_actor: this.actor,
          p_aliases_to_add: [],
        })
        result.mergeCount += 1
        result.mutationCount += 1
      } catch (error) {
        result.errors.push({ findingId: id, error: errorMessage(error).slice(0, 800) })
      }
    }

    return result
  }

  private async findingIds(runId: string, pairKeys: readonly string[]): Promise<Map<string, string>> {
    if (pairKeys.length === 0) return new Map()
    const { data, error } = await this.db
      .from('entity_catalog_maintenance_findings')
      .select('id, pair_key')
      .eq('run_id', runId)
      .in('pair_key', [...pairKeys])
    if (error) throw new Error(`Entity cleanup finding lookup failed: ${error.message}`)
    return new Map((data ?? []).map((row) => [String(row.pair_key), String(row.id)]))
  }

  private async rpc(name: string, args: Record<string, unknown>): Promise<void> {
    const { error } = await this.db.rpc(name, args)
    if (error) throw new Error(`${name} failed: ${error.message}`)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
