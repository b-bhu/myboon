import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { packageScriptArgs } from '../cli-args'
import { loadDotenvChain } from '../pipeline-store/cli-env'
import { PostgresKnowledgeOperationWriter } from './postgres-knowledge-writer'

interface PlanningReconciliationArgs {
  operationId: string
  attemptDigest: string
  requestDigest: string
  evidencePath: string
  operator: string
  apply: boolean
}

/** Explicit single-operation reconciliation; preview never opens the database. */
export function parsePlanningReconciliationArgs(args: readonly string[]): PlanningReconciliationArgs {
  const values = new Map<string, string>()
  let apply = false
  const allowed = new Set(['--operation', '--attempt', '--request-digest', '--evidence', '--operator'])
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index]!
    if (key === '--apply') {
      if (apply) throw new Error('Duplicate --apply')
      apply = true
      continue
    }
    const value = args[++index]
    if (!allowed.has(key) || values.has(key) || !value?.trim() || value.startsWith('--')) {
      throw new Error('Provide each supported reconciliation argument exactly once')
    }
    values.set(key, value.trim())
  }
  for (const key of allowed) if (!values.has(key)) throw new Error(`${key} is required`)
  for (const key of ['--attempt', '--request-digest']) {
    if (!/^[0-9a-f]{64}$/.test(values.get(key)!)) throw new Error(`${key} must be a SHA-256 digest`)
  }
  return {
    operationId: values.get('--operation')!, attemptDigest: values.get('--attempt')!,
    requestDigest: values.get('--request-digest')!, evidencePath: resolve(values.get('--evidence')!),
    operator: values.get('--operator')!, apply,
  }
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 1_000 || value.includes('\0')) {
    throw new Error(`Invalid provider execution record ${field}`)
  }
  return value.trim()
}

/** No operator assertion can stand in for an attributable, supported execution record. */
export function readPlanningNonExecutionProof(args: PlanningReconciliationArgs) {
  const bytes = readFileSync(args.evidencePath)
  if (bytes.length === 0 || bytes.length > 1_048_576) throw new Error('Provider execution record exceeds its bounds')
  const record = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>
  if (!record || Array.isArray(record) || record.schemaVersion !== 'myboon.provider_execution_record.v1'
    || record.operationId !== args.operationId || record.attemptDigest !== args.attemptDigest
    || record.requestDigest !== args.requestDigest || record.outcome !== 'confirmed_no_execution'
    || record.noExecution !== true || record.noCharge !== true
    || record.supportedProviderExecutionLookup !== true || record.verifiedBy !== args.operator) {
    throw new Error('A matching verified provider non-execution record is required; unknown outcomes remain held')
  }
  const observedAt = Date.parse(requiredText(record.observedAt, 'observedAt'))
  if (!Number.isFinite(observedAt) || observedAt > Date.now()) throw new Error('Invalid provider execution record time')
  return {
    source: 'provider_execution_record' as const,
    provider: requiredText(record.provider, 'provider'),
    proofRef: requiredText(record.providerRecordRef, 'providerRecordRef'),
    proofDigest: createHash('sha256').update(bytes).digest('hex'),
    confirmedBy: args.operator,
  }
}

async function main(): Promise<void> {
  const args = parsePlanningReconciliationArgs(packageScriptArgs(process.argv.slice(2)))
  const proof = readPlanningNonExecutionProof(args)
  if (!args.apply) {
    process.stdout.write(`${JSON.stringify({
      mode: 'preview', operationId: args.operationId, attemptDigest: args.attemptDigest,
      requestDigest: args.requestDigest, resolution: 'confirmed_no_execution', proof,
      applied: false, note: 'Database lease and exact dispatch checks occur only during an explicitly applied resolution',
    }, null, 2)}\n`)
    return
  }
  loadDotenvChain()
  const connectionString = process.env.MYBOON_MANAGED_KNOWLEDGE_DATABASE_URL?.trim()
  if (!connectionString) throw new Error('Dedicated managed-writer database URL is required')
  const writer = new PostgresKnowledgeOperationWriter({
    connectionString, ca: process.env.MYBOON_MANAGED_KNOWLEDGE_DATABASE_CA?.trim() || null,
  })
  try {
    await writer.resolvePlanningDispatch({
      operationId: args.operationId, attemptDigest: args.attemptDigest, requestDigest: args.requestDigest,
      resolution: 'confirmed_no_execution', proof,
    })
    process.stdout.write(`${JSON.stringify({ mode: 'apply', applied: true, operationId: args.operationId })}\n`)
  } finally {
    await writer.close()
  }
}

if (require.main === module) main().catch(() => {
  process.stderr.write('[entity-v4-planning-reconcile] Resolution unavailable; preserve the dispatch hold\n')
  process.exitCode = 1
})
