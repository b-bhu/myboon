import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { sqliteStoreId } from './sqlite-write-error-journal'
import type { EntityManagerV4Source } from './runtime-config'
import { loadEntityManagerV4RuntimeConfig } from './runtime-config'

export const V4_OWNERSHIP_TABLE = 'entity_v4_source_ownership'
export const V4_OWNERSHIP_RECEIPTS_TABLE = 'entity_v4_source_ownership_receipts'
export const V4_OWNERSHIP_OPERATIONS_TABLE = 'entity_v4_source_operations'
export const V4_OWNERSHIP_SCHEMA_VERSION = 'myboon.entity_v4_source_ownership.v1' as const
export type SourceOwnershipDomain = 'collector' | 'intake' | 'research' | 'entity'
export type SourceOwner = 'legacy' | 'shared'
export type SourceOwnershipAction = 'initialize' | 'pause' | 'resume_shared' | 'resume_legacy' | 'retire_legacy' | 'reconcile_abandoned'

export interface OwnershipSqliteDatabase {
  exec(sql: string): void
  close(): void
  prepare(sql: string): {
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
    run(...params: unknown[]): { changes: number | bigint }
  }
}

const { DatabaseSync } = createRequire(__filename)('node:sqlite') as {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => OwnershipSqliteDatabase
}

export interface SourceOwnershipSnapshot {
  source: EntityManagerV4Source
  revision: number
  state: 'paused' | 'running'
  owners: Record<SourceOwnershipDomain, SourceOwner>
  legacyQueueEnabled: boolean
  legacyRetired: boolean
  lastReceiptId: string
  updatedAt: string
}

export interface SourceOwnershipGateInput {
  databasePath: string
  source: EntityManagerV4Source
  domain: SourceOwnershipDomain
  owner: SourceOwner
  env?: Readonly<Record<string, string | undefined>>
}

export function sourceOwnershipEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const value = env.ENTITY_V4_SOURCE_OWNERSHIP_ENABLED
  if (value !== undefined && value !== '0' && value !== '1') throw new Error('ENTITY_V4_SOURCE_OWNERSHIP_ENABLED must be 0 or 1')
  return value === '1'
}

function tableExists(db: OwnershipSqliteDatabase, name: string): boolean {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name)
}

export function readSourceOwnership(db: OwnershipSqliteDatabase, source: EntityManagerV4Source): SourceOwnershipSnapshot | null {
  if (!tableExists(db, V4_OWNERSHIP_TABLE)) return null
  const row = db.prepare(`SELECT * FROM ${V4_OWNERSHIP_TABLE} WHERE source_type=?`).get(source) as Record<string, unknown> | undefined
  if (!row) return null
  const owners = Object.fromEntries((['collector', 'intake', 'research', 'entity'] as const).map((domain) => {
    const owner = row[`${domain}_owner`]
    if (owner !== 'legacy' && owner !== 'shared') throw new Error('Source ownership contains an invalid owner')
    return [domain, owner]
  })) as SourceOwnershipSnapshot['owners']
  if (!Number.isSafeInteger(row.revision) || Number(row.revision) < 1 || (row.state !== 'paused' && row.state !== 'running')) {
    throw new Error('Source ownership contains invalid state or revision')
  }
  return {
    source, revision: Number(row.revision), state: row.state, owners,
    legacyQueueEnabled: Number(row.legacy_queue_enabled) === 1,
    legacyRetired: Number(row.legacy_retired) === 1,
    lastReceiptId: String(row.last_receipt_id), updatedAt: String(row.updated_at),
  }
}

/** For store write transactions: read authority on the same connection as the mutation. */
export function sourceOwnershipAllowsOnDatabase(input: Omit<SourceOwnershipGateInput, 'databasePath'> & { db: OwnershipSqliteDatabase }): boolean {
  const enabled = sourceOwnershipEnabled(input.env)
  const snapshot = readSourceOwnership(input.db, input.source)
  // Once durable authority exists it stays authoritative even for stale process env.
  if (!snapshot) return !enabled
  if (snapshot.state !== 'running' || snapshot.owners[input.domain] !== input.owner) return false
  if (input.domain === 'collector' && input.owner === 'legacy') return snapshot.legacyQueueEnabled && !snapshot.legacyRetired
  return true
}

export function sourceOwnershipAllows(input: SourceOwnershipGateInput): boolean {
  const enabled = sourceOwnershipEnabled(input.env)
  if (!existsSync(resolve(input.databasePath))) return !enabled
  let db: OwnershipSqliteDatabase | null = null
  try {
    db = new DatabaseSync(resolve(input.databasePath), { readOnly: true })
    db.exec('PRAGMA busy_timeout=5000;')
    return sourceOwnershipAllowsOnDatabase({ ...input, db })
  } catch {
    // With no durable authority and the feature disabled, retain legacy startup semantics.
    return false
  } finally { db?.close() }
}

export function requireSourceOwnership(input: SourceOwnershipGateInput): void {
  if (!sourceOwnershipAllows(input)) throw new Error(`V4 source ownership fences ${input.source}/${input.domain}/${input.owner}`)
}

/** Durable activity for legacy operations that have no native lease record. Crashed work stays held. */
export async function withSourceOwnershipOperation<T>(input: SourceOwnershipGateInput & { observationsOnly?: boolean }, action: () => Promise<T>): Promise<T> {
  if(input.observationsOnly && input.domain!=='collector')throw new Error('Observation-only activity is limited to source collectors')
  if (!existsSync(resolve(input.databasePath))) {
    if (sourceOwnershipEnabled(input.env)) throw new Error('Source ownership database is unavailable')
    return action()
  }
  const inspection=new DatabaseSync(resolve(input.databasePath),{readOnly:true})
  let existing:SourceOwnershipSnapshot|null
  try{existing=readSourceOwnership(inspection,input.source)}finally{inspection.close()}
  if(!existing){
    if(!sourceOwnershipEnabled(input.env)||input.observationsOnly)return action()
    throw new Error('Source ownership authority is not initialized')
  }
  const db = new DatabaseSync(resolve(input.databasePath))
  db.exec('PRAGMA busy_timeout=5000;')
  const operationId = randomUUID()
  let tracked = false
  try {
    db.exec('BEGIN IMMEDIATE')
    try {
      const snapshot = readSourceOwnership(db,input.source)
      if (!input.observationsOnly && !sourceOwnershipAllowsOnDatabase({...input,db})) throw new Error('Source ownership fences operation start')
      if (snapshot) {
        db.prepare(`INSERT INTO ${V4_OWNERSHIP_OPERATIONS_TABLE} (operation_id,source_type,domain,owner,ownership_revision,state,started_at) VALUES (?,?,?,?,?,'inflight',?)`).run(
          operationId,input.source,input.domain,input.observationsOnly?snapshot.owners.collector:input.owner,snapshot.revision,new Date().toISOString(),
        )
        tracked=true
      }
      db.exec('COMMIT')
    } catch (error) { try {db.exec('ROLLBACK')} catch {} throw error }
    try { return await action() }
    finally {
      if (tracked) db.prepare(`UPDATE ${V4_OWNERSHIP_OPERATIONS_TABLE} SET state='finished',finished_at=? WHERE operation_id=? AND state='inflight'`).run(new Date().toISOString(),operationId)
    }
  } finally { db.close() }
}

export interface SourceOwnershipArtifactBinding {
  path: string
  sha256: string
}

/** Receipt builders bind the same secret-free numerical policy used at execution. */
export function sourceOwnershipConfigurationDigest(env:Readonly<Record<string,string|undefined>>=process.env):string {
  const config=loadEntityManagerV4RuntimeConfig(env)
  return digest(JSON.stringify({
    managedWriterEnabled:config.managedWriterEnabled,articleWorkflowEnabled:config.articleWorkflowEnabled,noveltyEnabled:config.noveltyEnabled,
    researchReuseEnabled:config.researchReuseEnabled,followupEnabled:config.followupEnabled,
    sourceOwnershipEnabled:config.sourceOwnershipEnabled,activeSources:[...config.activeSources].sort(),
    policyVersion:config.policyVersion,assignmentPolicy:config.assignmentPolicy,synthesisPolicy:config.synthesisPolicy,reusePolicy:config.reusePolicy,followupPolicy:config.followupPolicy,
  }))
}

export interface SourceOwnershipReceipt {
  schemaVersion: 'myboon.entity_v4_source_ownership_receipt.v1'
  receiptId: string
  source: EntityManagerV4Source
  storeId: string
  action: SourceOwnershipAction
  expectedRevision: number
  expectedReceiptId: string | null
  approvedBy: string
  approvedAt: string
  expiresAt: string
  artifacts: Record<'backup_restore' | 'evaluation' | 'health' | 'allowance' | 'reconciliation', SourceOwnershipArtifactBinding>
  /** Separate executed News ownership evidence is mandatory before Polymarket activation. */
  newsReceipt?: { databasePath: string; receiptId: string; receiptSha256: string }
  /** Exact crashed operations only; never translates retained history into queued work. */
  abandonedOperationIds?: string[]
}

export interface SourceOwnershipOperationResult {
  schemaVersion: typeof V4_OWNERSHIP_SCHEMA_VERSION
  mode: 'preview' | 'apply'
  source: EntityManagerV4Source
  action: SourceOwnershipAction
  current: SourceOwnershipSnapshot | null
  proposed: SourceOwnershipSnapshot
  evidenceSha256: string
  replayed: boolean
  reconciled: ReturnType<typeof readSourceOwnershipObligations>
}

/** Opened only by the explicit operator command; normal workers never initialize authority. */
export class SqliteSourceOwnershipOperator {
  private readonly db: OwnershipSqliteDatabase
  private readonly path: string
  constructor(path: string, private readonly readOnly = true) {
    this.path = resolve(path)
    if(!existsSync(this.path))throw new Error('Source ownership requires an existing source database')
    this.db = new DatabaseSync(this.path, { readOnly })
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;')
  }

  run(input: { receiptPath: string; operatorId: string; apply?: boolean; now: string }): SourceOwnershipOperationResult {
    if (input.apply && this.readOnly) throw new Error('Read-only ownership operator cannot apply')
    if (input.apply) this.db.exec('BEGIN IMMEDIATE')
    try {
      // Bind receipt and every artifact again while the source write lock is held.
      const { receipt, sha256 } = readOwnershipReceipt(input.receiptPath, input.operatorId, input.now, this.path)
      const current = readSourceOwnership(this.db, receipt.source)
      if (tableExists(this.db, V4_OWNERSHIP_RECEIPTS_TABLE)) {
        const previous = this.db.prepare(`SELECT receipt_sha256, result_json FROM ${V4_OWNERSHIP_RECEIPTS_TABLE} WHERE receipt_id=?`).get(receipt.receiptId) as Record<string, unknown> | undefined
        if (previous) {
          if (previous.receipt_sha256 !== sha256) throw new Error('Ownership receipt ID was reused with changed content')
          const result = JSON.parse(String(previous.result_json)) as SourceOwnershipOperationResult
          if (input.apply) this.db.exec('COMMIT')
          return { ...result, mode: input.apply ? 'apply' : 'preview', replayed: true }
        }
      }
      if ((current?.revision ?? 0) !== receipt.expectedRevision) throw new Error('Source ownership revision changed; a new approval receipt is required')
      if((current?.lastReceiptId??null)!==receipt.expectedReceiptId)throw new Error('Ownership approval does not bind the current executed receipt')
      const obligations = readSourceOwnershipObligations(this.db, receipt.source)
      validateTransition(receipt, current, obligations)
      if(receipt.action==='reconcile_abandoned'){
        for(const id of receipt.abandonedOperationIds!){
          const record=this.db.prepare(`SELECT operation_id FROM ${V4_OWNERSHIP_OPERATIONS_TABLE} WHERE operation_id=? AND source_type=? AND state='inflight'`).get(id,receipt.source)
          if(!record)throw new Error('Abandoned operation changed or does not belong to this source')
        }
      }
      const proposed = proposeOwnership(receipt, current, input.now)
      const result: SourceOwnershipOperationResult = {
        schemaVersion: V4_OWNERSHIP_SCHEMA_VERSION, mode: input.apply ? 'apply' : 'preview',
        source: receipt.source, action: receipt.action, current, proposed,
        evidenceSha256: sha256, replayed: false, reconciled: obligations,
      }
      if (input.apply) {
        this.ensureSchema()
        if (receipt.action === 'reconcile_abandoned') {
          for (const id of receipt.abandonedOperationIds!) {
            const changed=this.db.prepare(`UPDATE ${V4_OWNERSHIP_OPERATIONS_TABLE} SET state='reconciled_abandoned',finished_at=?,reconciliation_receipt_id=? WHERE operation_id=? AND source_type=? AND state='inflight'`).run(input.now,receipt.receiptId,id,receipt.source)
            if (Number(changed.changes)!==1) throw new Error('Abandoned operation changed or does not belong to this source')
          }
        }
        // Source-native triggers are installed before any new owner can run.
        installSourceOwnershipFences(this.db, receipt.source)
        this.db.prepare(`INSERT INTO ${V4_OWNERSHIP_TABLE} (
          source_type,revision,state,collector_owner,intake_owner,research_owner,entity_owner,
          legacy_queue_enabled,legacy_retired,last_receipt_id,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_type) DO UPDATE SET
          revision=excluded.revision,state=excluded.state,collector_owner=excluded.collector_owner,
          intake_owner=excluded.intake_owner,research_owner=excluded.research_owner,entity_owner=excluded.entity_owner,
          legacy_queue_enabled=excluded.legacy_queue_enabled,legacy_retired=excluded.legacy_retired,
          last_receipt_id=excluded.last_receipt_id,updated_at=excluded.updated_at`).run(
          proposed.source,proposed.revision,proposed.state,proposed.owners.collector,proposed.owners.intake,
          proposed.owners.research,proposed.owners.entity,Number(proposed.legacyQueueEnabled),Number(proposed.legacyRetired),receipt.receiptId,input.now,
        )
        this.db.prepare(`INSERT INTO ${V4_OWNERSHIP_RECEIPTS_TABLE} (receipt_id,source_type,receipt_sha256,receipt_json,result_json,executed_at) VALUES (?,?,?,?,?,?)`).run(
          receipt.receiptId,receipt.source,sha256,JSON.stringify(receipt),JSON.stringify(result),input.now,
        )
        this.db.exec('COMMIT')
      }
      return result
    } catch (error) {
      if (input.apply) { try { this.db.exec('ROLLBACK') } catch { /* preserve original failure */ } }
      throw error
    }
  }

  private ensureSchema(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS ${V4_OWNERSHIP_TABLE} (
      source_type TEXT PRIMARY KEY CHECK(source_type IN ('news','polymarket')),
      revision INTEGER NOT NULL CHECK(revision>0),state TEXT NOT NULL CHECK(state IN ('paused','running')),
      collector_owner TEXT NOT NULL CHECK(collector_owner IN ('legacy','shared')),
      intake_owner TEXT NOT NULL CHECK(intake_owner IN ('legacy','shared')),
      research_owner TEXT NOT NULL CHECK(research_owner IN ('legacy','shared')),
      entity_owner TEXT NOT NULL CHECK(entity_owner IN ('legacy','shared')),
      legacy_queue_enabled INTEGER NOT NULL CHECK(legacy_queue_enabled IN (0,1)),
      legacy_retired INTEGER NOT NULL CHECK(legacy_retired IN (0,1)),last_receipt_id TEXT NOT NULL,updated_at TEXT NOT NULL
    ); CREATE TABLE IF NOT EXISTS ${V4_OWNERSHIP_RECEIPTS_TABLE} (
      receipt_id TEXT PRIMARY KEY,source_type TEXT NOT NULL,receipt_sha256 TEXT NOT NULL,
      receipt_json TEXT NOT NULL,result_json TEXT NOT NULL,executed_at TEXT NOT NULL
    ); CREATE TABLE IF NOT EXISTS ${V4_OWNERSHIP_OPERATIONS_TABLE} (
      operation_id TEXT PRIMARY KEY,source_type TEXT NOT NULL,domain TEXT NOT NULL,owner TEXT NOT NULL,
      ownership_revision INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('inflight','finished','reconciled_abandoned')),
      started_at TEXT NOT NULL,finished_at TEXT,reconciliation_receipt_id TEXT
    );`)
  }
  close(): void { this.db.close() }
}

export function readSourceOwnershipObligations(db: OwnershipSqliteDatabase, source: EntityManagerV4Source): {
  pendingDeliveries: number | null
  sharedLeases: number | null
  legacyResearchInflight: number | null
  legacyEntityInflight: number | null
  unknownPaidOutcomes: number | null
  pendingReservations: number | null
  trackedInflightOperations: number | null
} {
  const count = (table: string, where: string, params: unknown[] = []) => {
    if (!tableExists(db, table)) return null
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...params) as { n: number }
    return Number(row.n)
  }
  const news = source === 'news'
  return {
    pendingDeliveries: count(news ? 'news_source_delivery_outbox' : 'pipeline_source_delivery_outbox', "state='pending'"),
    sharedLeases: count('signal_platform_research_work', "source_type=? AND (lease_id IS NOT NULL OR status IN ('retrieval_leased','deep_leased','synthesis_leased','entity_leased'))", [source]),
    legacyResearchInflight: news
      ? count('news_candidate_observations', "status IN ('research_queued','researching')")
      : count('pipeline_candidates', "source=? AND status='researching'", [source]),
    legacyEntityInflight: news
      ? tableExists(db,V4_OWNERSHIP_OPERATIONS_TABLE) ? count(V4_OWNERSHIP_OPERATIONS_TABLE,"source_type='news' AND domain='entity' AND owner='legacy' AND state='inflight'") : 0
      : count('pipeline_research', "source=? AND entity_manager_status='processing'", [source]),
    unknownPaidOutcomes: count('signal_platform_research_reservations', "source_type=? AND state IN ('dispatch_intent','execution_outcome_unknown')", [source]),
    pendingReservations: count('signal_platform_research_reservations', "source_type=? AND state='reserved_not_dispatched'", [source]),
    trackedInflightOperations: tableExists(db,V4_OWNERSHIP_OPERATIONS_TABLE) ? count(V4_OWNERSHIP_OPERATIONS_TABLE,"source_type=? AND state='inflight'",[source]) : 0,
  }
}

function validateTransition(receipt: SourceOwnershipReceipt, current: SourceOwnershipSnapshot | null, obligations: ReturnType<typeof readSourceOwnershipObligations>): void {
  if (receipt.action === 'initialize') {
    if (current) throw new Error('Source ownership already initialized')
    return
  }
  if (!current) throw new Error('Initialize source ownership before changing it')
  if (receipt.action === 'pause') return
  if (receipt.action === 'reconcile_abandoned') {
    if (current.state!=='paused') throw new Error('Pause source before reconciling abandoned operations')
    if (!receipt.abandonedOperationIds?.length || receipt.abandonedOperationIds.length>100
      || new Set(receipt.abandonedOperationIds).size!==receipt.abandonedOperationIds.length) throw new Error('Supply 1-100 unique abandoned operation IDs')
    return
  }
  if (receipt.action !== 'retire_legacy' && current.state !== 'paused') throw new Error('Pause source admissions and claims before changing or reopening ownership')
  if (Object.values(obligations).some((n) => n === null || n !== 0)) {
    throw new Error('Ownership change requires available zero in-flight, pending-delivery, and unknown-payment obligations')
  }
  if (receipt.action === 'retire_legacy' && (current.state !== 'running' || Object.values(current.owners).some((o) => o !== 'shared') || current.legacyQueueEnabled)) {
    throw new Error('Retirement requires healthy exclusive shared ownership and fenced legacy queue writes')
  }
}

function proposeOwnership(receipt: SourceOwnershipReceipt, current: SourceOwnershipSnapshot | null, now: string): SourceOwnershipSnapshot {
  const owner: SourceOwner = receipt.action === 'resume_shared' || receipt.action === 'retire_legacy' ? 'shared'
    : receipt.action === 'resume_legacy' ? 'legacy' : current?.owners.research ?? 'legacy'
  const running = receipt.action === 'resume_shared' || receipt.action === 'resume_legacy' || receipt.action === 'retire_legacy'
  return {
    source: receipt.source,revision:(current?.revision ?? 0)+1,state:running ? 'running' : 'paused',
    owners: { collector:owner,intake:owner,research:owner,entity:owner },
    legacyQueueEnabled:running && owner === 'legacy',legacyRetired:receipt.action === 'retire_legacy' ? true : receipt.action === 'resume_legacy' ? false : current?.legacyRetired ?? false,
    lastReceiptId:receipt.receiptId,updatedAt:now,
  }
}

function readOwnershipReceipt(path: string, operatorId: string, now: string, databasePath: string): { receipt: SourceOwnershipReceipt; sha256: string } {
  const bytes = readFileSync(resolve(path), 'utf8')
  const receipt = JSON.parse(bytes) as SourceOwnershipReceipt
  if (receipt.schemaVersion !== 'myboon.entity_v4_source_ownership_receipt.v1' || !receipt.receiptId?.trim()
    || !['news','polymarket'].includes(receipt.source) || !['initialize','pause','resume_shared','resume_legacy','retire_legacy','reconcile_abandoned'].includes(receipt.action)
    || !Number.isSafeInteger(receipt.expectedRevision) || receipt.expectedRevision < 0
    || (receipt.expectedRevision===0 ? receipt.expectedReceiptId!==null : typeof receipt.expectedReceiptId!=='string'||!receipt.expectedReceiptId.trim())
    || !operatorId.trim() || receipt.approvedBy !== operatorId || receipt.storeId !== sqliteStoreId(databasePath)) throw new Error('Ownership receipt does not match operator/source/store/action')
  const clock = Date.parse(now), approved = Date.parse(receipt.approvedAt), expires = Date.parse(receipt.expiresAt)
  if (![clock,approved,expires].every(Number.isFinite) || approved > clock || expires <= clock || expires <= approved) throw new Error('Ownership receipt approval is expired or invalid')
  for (const kind of ['backup_restore','evaluation','health','allowance','reconciliation'] as const) {
    const binding = receipt.artifacts?.[kind]
    if (!binding?.path || !/^[a-f0-9]{64}$/.test(binding.sha256)) throw new Error(`Ownership receipt requires ${kind} artifact binding`)
    const artifactBytes = readFileSync(resolve(dirname(resolve(path)), binding.path), 'utf8')
    if (digest(artifactBytes) !== binding.sha256) throw new Error(`Ownership ${kind} artifact changed`)
    const artifact = JSON.parse(artifactBytes) as Record<string, unknown>
    if (artifact.schemaVersion !== 'myboon.entity_v4_ownership_evidence.v1' || artifact.kind !== kind
      || artifact.source !== receipt.source || artifact.storeId !== receipt.storeId || artifact.passed !== true
      || artifact.reviewedBy !== operatorId || !Number.isFinite(Date.parse(String(artifact.observedAt)))
      || Date.parse(String(artifact.observedAt)) > approved) throw new Error(`Ownership ${kind} evidence is invalid or not reviewed`)
    if (kind === 'backup_restore' && (artifact.backupVerified !== true || artifact.restoreVerified !== true)) throw new Error('A verified backup AND restore rehearsal are required')
    if (kind === 'allowance' && (typeof artifact.policyVersion!=='string' || !artifact.policyVersion.trim()
      || artifact.configSha256!==sourceOwnershipConfigurationDigest())) throw new Error('Allowance evidence must bind reviewed policy and current runtime configuration')
    if (kind === 'health' && receipt.action !== 'pause' && artifact.workersStopped !== true) throw new Error('Ownership transitions require independently verified stopped source workers')
    if((kind==='health'||kind==='reconciliation')&&(artifact.ownershipRevision!==receipt.expectedRevision||artifact.ownershipReceiptId!==receipt.expectedReceiptId)) throw new Error('Operational evidence must bind the current executed ownership revision and receipt')
    if(kind==='health'&&receipt.action==='retire_legacy') {
      const observedDurationMs=Date.parse(String(artifact.observedAt))-Date.parse(String(artifact.observationStartedAt))
      if(artifact.canonicalPathHealthy!==true||!Number.isSafeInteger(artifact.requiredHealthyWindowMs)||Number(artifact.requiredHealthyWindowMs)<=0
        ||!Number.isFinite(observedDurationMs)||observedDurationMs<Number(artifact.requiredHealthyWindowMs)) throw new Error('Retirement requires the complete operator-approved healthy observation window')
    }
    if (kind === 'reconciliation' && (artifact.inflightReconciled !== true || artifact.outboxReconciled !== true || artifact.residualReferencesAccounted !== true
      || artifact.managedLeasesReconciled !== true || artifact.managedPlanningDispatchesReconciled !== true)) throw new Error('Source obligations, private managed leases/dispatches and residual references must be reconciled')
  }
  if (receipt.source === 'polymarket' && (receipt.action === 'resume_shared' || receipt.action === 'retire_legacy')) {
    const news = receipt.newsReceipt
    if (!news?.databasePath || !news.receiptId || !/^[a-f0-9]{64}$/.test(news.receiptSha256)) throw new Error('Executed News ownership evidence is required before Polymarket')
    const db = new DatabaseSync(resolve(news.databasePath), { readOnly:true })
    try {
      const snapshot = readSourceOwnership(db,'news')
      const executed = db.prepare(`SELECT receipt_sha256 FROM ${V4_OWNERSHIP_RECEIPTS_TABLE} WHERE receipt_id=? AND source_type='news'`).get(news.receiptId) as { receipt_sha256:string } | undefined
      if (!snapshot || snapshot.state !== 'running' || Object.values(snapshot.owners).some((o)=>o !== 'shared')
        || snapshot.lastReceiptId !== news.receiptId || executed?.receipt_sha256 !== news.receiptSha256) throw new Error('News ownership evidence is stale or not exclusively shared')
    } finally { db.close() }
  }
  return {receipt,sha256:digest(bytes)}
}

function digest(value:string):string { return createHash('sha256').update(value).digest('hex') }

/** Atomic replacement also nests safely inside an existing operator transaction. */
export function installSourceOwnershipFences(db:OwnershipSqliteDatabase,source:EntityManagerV4Source):void {
  const savepoint=`v4_${source}_ownership_fences`
  db.exec(`SAVEPOINT ${savepoint}`)
  try {
  const guard = (name:string,table:string,event:string,when:string,domain:SourceOwnershipDomain,owner:SourceOwner) => {
    if (!tableExists(db,table)) throw new Error(`Source ownership cannot fence missing table ${table}`)
    const ownerCondition = `${domain}_owner='${owner}' AND state='running'${domain === 'collector' && owner === 'legacy' ? ' AND legacy_queue_enabled=1 AND legacy_retired=0' : ''}`
    db.exec(`DROP TRIGGER IF EXISTS ${name}; CREATE TRIGGER ${name} BEFORE ${event} ON ${table}
      WHEN (${when}) AND NOT EXISTS(SELECT 1 FROM ${V4_OWNERSHIP_TABLE} WHERE source_type='${source}' AND ${ownerCondition})
      BEGIN SELECT RAISE(ABORT,'V4_SOURCE_OWNERSHIP_FENCED'); END;`)
  }
  guard(`v4_${source}_shared_admission`,'signal_platform_research_work','INSERT',`NEW.source_type='${source}'`,'intake','shared')
  guard(`v4_${source}_shared_research_claim`,'signal_platform_research_work','UPDATE OF lease_id,status',`NEW.source_type='${source}' AND NEW.lease_id IS NOT NULL AND NEW.status IN ('retrieval_leased','deep_leased','synthesis_leased') AND (NEW.lease_id IS NOT OLD.lease_id OR NEW.status IS NOT OLD.status)`,'research','shared')
  guard(`v4_${source}_shared_entity_claim`,'signal_platform_research_work','UPDATE OF lease_id,status',`NEW.source_type='${source}' AND NEW.lease_id IS NOT NULL AND NEW.status='entity_leased' AND (NEW.lease_id IS NOT OLD.lease_id OR NEW.status IS NOT OLD.status)`,'entity','shared')
  if (source === 'news') {
    guard('v4_news_legacy_admission','news_candidate_observations','INSERT',"NEW.status='pending_research'",'collector','legacy')
    guard('v4_news_legacy_requeue','news_candidate_observations','UPDATE OF status',"NEW.status='pending_research' AND NEW.status IS NOT OLD.status",'collector','legacy')
    guard('v4_news_legacy_claim','news_candidate_observations','UPDATE OF status',"NEW.status IN ('research_queued','researching') AND NEW.status IS NOT OLD.status",'research','legacy')
  } else {
    const leaseColumns=(table:string,candidates:string[])=>{
      const columns=new Set((db.prepare(`PRAGMA table_info(${table})`).all() as {name:string}[]).map(row=>row.name))
      return candidates.filter(column=>columns.has(column))
    }
    const researchLeaseColumns=leaseColumns('pipeline_candidates',['lease_id','lease_owner','lease_expires_at'])
    const entityLeaseColumns=leaseColumns('pipeline_research',['entity_manager_lease_id','entity_manager_lease_owner','entity_manager_lease_expires_at'])
    const changed=(status:string,columns:string[])=>[
      `NEW.${status} IS NOT OLD.${status}`,
      ...columns.map(column=>`(NEW.${column} IS NOT NULL AND NEW.${column} IS NOT OLD.${column})`),
    ].join(' OR ')
    guard('v4_polymarket_legacy_admission','pipeline_candidates','INSERT',"NEW.source='polymarket' AND NEW.status='pending_research'",'collector','legacy')
    guard('v4_polymarket_legacy_requeue','pipeline_candidates','UPDATE OF status',"NEW.source='polymarket' AND NEW.status='pending_research' AND NEW.status IS NOT OLD.status",'collector','legacy')
    guard('v4_polymarket_legacy_claim','pipeline_candidates',`UPDATE OF ${['status',...researchLeaseColumns].join(',')}`,`NEW.source='polymarket' AND NEW.status='researching' AND (${changed('status',researchLeaseColumns)})`,'research','legacy')
    guard('v4_polymarket_legacy_entity_claim','pipeline_research',`UPDATE OF ${['entity_manager_status',...entityLeaseColumns].join(',')}`,`NEW.source='polymarket' AND NEW.entity_manager_status='processing' AND (${changed('entity_manager_status',entityLeaseColumns)})`,'entity','legacy')
  }
    db.exec(`RELEASE SAVEPOINT ${savepoint}`)
  } catch(error) {
    try{db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`)}catch{/* preserve the original schema failure */}
    throw error
  }
}
