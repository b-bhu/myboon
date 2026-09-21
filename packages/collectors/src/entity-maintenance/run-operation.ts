import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { loadDotenvChain, requiredEnv } from '../pipeline-store/cli-env'

type OperatorCommand =
  | { kind: 'approve', findingId: string, actor: string }
  | { kind: 'reject', findingId: string, actor: string }
  | { kind: 'quarantine-alias', findingId: string, actor: string }
  | { kind: 'prepare-merge', findingId: string, actor: string }
  | { kind: 'apply-merge', findingId: string, actor: string }
  | { kind: 'rollback-alias', operationId: string, actor: string }
  | { kind: 'rollback-merge', operationId: string, actor: string }

export function parseOperatorCommand(args: readonly string[]): OperatorCommand {
  const [kind, id, actor] = args
  if (!kind || !id?.trim() || !actor?.trim() || args.length !== 3) {
    throw new Error('Usage: entity-catalog:operate <approve|reject|quarantine-alias|prepare-merge|apply-merge|rollback-alias|rollback-merge> <finding-or-operation-id> <actor>')
  }
  if (kind === 'approve' || kind === 'reject' || kind === 'quarantine-alias'
    || kind === 'prepare-merge' || kind === 'apply-merge') {
    return { kind, findingId: id.trim(), actor: actor.trim() }
  }
  if (kind === 'rollback-alias' || kind === 'rollback-merge') {
    return { kind, operationId: id.trim(), actor: actor.trim() }
  }
  throw new Error(`Unsupported Entity catalogue operation: ${kind}.`)
}

export async function executeOperatorCommand(db: SupabaseClient, command: OperatorCommand): Promise<Record<string, unknown>> {
  if (command.kind === 'approve' || command.kind === 'reject') {
    const reviewStatus = command.kind === 'approve' ? 'approved' : 'rejected'
    const { data, error } = await db
      .from('entity_catalog_maintenance_findings')
      .update({
        review_status: reviewStatus,
        reviewed_by: command.actor,
        reviewed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', command.findingId)
      .eq('review_status', 'pending')
      .select('id, review_status')
      .maybeSingle()
    if (error) throw new Error(`Entity finding review failed: ${error.message}`)
    if (!data) throw new Error('Entity finding is missing or no longer pending.')
    return { command: command.kind, findingId: data.id, reviewStatus: data.review_status }
  }

  let rpc: { name: string, args: Record<string, unknown> }
  if (command.kind === 'quarantine-alias') {
    rpc = { name: 'entity_catalog_quarantine_alias_v1', args: { p_finding_id: command.findingId, p_actor: command.actor } }
  } else if (command.kind === 'prepare-merge') {
    rpc = { name: 'entity_catalog_prepare_merge_v1', args: { p_finding_id: command.findingId, p_actor: command.actor } }
  } else if (command.kind === 'apply-merge') {
    rpc = {
      name: 'entity_catalog_apply_merge_v1',
      args: { p_finding_id: command.findingId, p_actor: command.actor, p_aliases_to_add: [] },
    }
  } else if (command.kind === 'rollback-merge') {
    rpc = { name: 'entity_catalog_rollback_merge_v1', args: { p_operation_id: command.operationId, p_actor: command.actor } }
  } else {
    rpc = { name: 'entity_catalog_rollback_alias_quarantine_v1', args: { p_operation_id: command.operationId, p_actor: command.actor } }
  }
  const { data, error } = await db.rpc(rpc.name, rpc.args)
  if (error) throw new Error(`Entity catalogue ${command.kind} failed: ${error.message}`)
  return { command: command.kind, operationId: data }
}

async function main(): Promise<void> {
  loadDotenvChain()
  const command = parseOperatorCommand(process.argv.slice(2))
  const db = createClient(requiredEnv('SUPABASE_URL'), requiredEnv('SUPABASE_SERVICE_ROLE_KEY'))
  console.log(JSON.stringify(await executeOperatorCommand(db, command), null, 2))
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
