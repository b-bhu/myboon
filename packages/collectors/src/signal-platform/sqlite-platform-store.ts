import { mkdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { canonicalJson } from './canonical-json'
import type {
  ResearchPacketV1,
  ResearchWorkItem,
  RetrievedEvidence,
  Signal,
  FailureCategory,
  WorkStatus,
} from './contracts'
import type { TriageDecisionV1 } from './triage-contracts'
import type { TriageCapacitySnapshot } from './triage-contracts'
import type { WorkObservabilityReadPort } from './control-plane'
import {
  ImmutableRecordConflictError,
  type CanonicalPlatformStore,
  type ImmutableAppendResult,
  type SignalObservationRecord,
  type SignalObservationAppendResult,
} from './platform-store'
import {
  assertLeasedTransition,
  leasedStatusFor,
  pendingStatusFor,
  type HeartbeatCommand,
  type BeginAttemptCommand,
  type LeaseCommand,
  type LeasedTransitionCommand,
  type RecoveryResult,
  type ReleaseLeaseCommand,
  type SchedulerAggregateStatus,
  type SchedulerQuery,
  type WorkLease,
} from './store-adapter'
import {
  validateResearchPacket,
  validateResearchWorkItem,
  validateRetrievedEvidence,
  validateSignal,
} from './validation'
import { validateTriageDecision } from './triage-validation'
import {
  sqliteStoreId,
  type SqliteWriteHealthJournalPort,
} from './sqlite-write-error-journal'

interface SqliteRunResult { changes: number | bigint }
interface SqliteStatement {
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
  run(...params: unknown[]): SqliteRunResult
}
interface SqliteDatabase {
  close(): void
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
}

const nodeRequire = createRequire(__filename)
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean; open?: boolean }) => SqliteDatabase
}

export interface SqliteSignalPlatformStoreOptions {
  readOnly?: boolean
  writeHealthJournal?: SqliteWriteHealthJournalPort | null
  writeHealthStaleAfterMs?: number
}

export const SIGNAL_PLATFORM_TABLES = [
  'signal_platform_signals',
  'signal_platform_signal_observations',
  'signal_platform_triage_decisions',
  'signal_platform_research_work',
  'signal_platform_evidence',
  'signal_platform_research_packets',
] as const

const PENDING_STATUSES = ['research_pending', 'deep_pending', 'synthesis_pending', 'entity_pending'] as const
const LEASED_STATUSES = ['retrieval_leased', 'deep_leased', 'synthesis_leased', 'entity_leased'] as const
const CAPACITY_STATUSES = [...PENDING_STATUSES, ...LEASED_STATUSES, 'retry_wait'] as const

export interface TriageCapacityLimits {
  byPriority: Record<ResearchWorkItem['priorityClass'], number>
  byDepth: Record<ResearchWorkItem['researchDepth'], number>
  reservedByPriority?: Partial<Record<ResearchWorkItem['priorityClass'], number>>
}

/** Additive canonical store that can share either legacy SQLite database. */
export class SqliteSignalPlatformStore implements CanonicalPlatformStore {
  readonly sourceType: Signal['sourceType']
  private readonly db: SqliteDatabase
  private readonly databasePath: string
  private readonly storeId: string
  private readonly writeHealthJournal: SqliteWriteHealthJournalPort | null
  private readonly writeHealthStaleAfterMs: number
  private closed = false

  constructor(path: string, sourceType: Signal['sourceType'], options: SqliteSignalPlatformStoreOptions = {}) {
    this.sourceType = sourceType
    const resolved = resolve(path)
    this.databasePath = resolved
    this.storeId = sqliteStoreId(resolved)
    this.writeHealthJournal = options.writeHealthJournal ?? null
    this.writeHealthStaleAfterMs = options.writeHealthStaleAfterMs ?? 5 * 60_000
    if (!options.readOnly) mkdirSync(dirname(resolved), { recursive: true })
    this.db = new DatabaseSync(resolved, options.readOnly ? { readOnly: true, open: true } : {})
    if (options.readOnly) {
      this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;')
      return
    }
    try { this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS signal_platform_signals (
        signal_id TEXT PRIMARY KEY,
        schema_version TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        canonical_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(source_type, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS idx_signal_platform_signals_source_observed
        ON signal_platform_signals(source_type, observed_at DESC, signal_id);

      CREATE TABLE IF NOT EXISTS signal_platform_signal_observations (
        observation_id TEXT PRIMARY KEY,
        signal_id TEXT NOT NULL,
        source_type TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        deduplicated INTEGER NOT NULL CHECK(deduplicated IN (0, 1)),
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_signal_platform_observations_source_time
        ON signal_platform_signal_observations(source_type, observed_at, observation_id);

      CREATE TABLE IF NOT EXISTS signal_platform_triage_decisions (
        decision_id TEXT PRIMARY KEY,
        schema_version TEXT NOT NULL,
        signal_id TEXT NOT NULL,
        source_type TEXT NOT NULL,
        outcome TEXT NOT NULL,
        priority_class TEXT NOT NULL,
        priority_policy_version TEXT NOT NULL,
        budget_policy_version TEXT NOT NULL,
        decided_at TEXT NOT NULL,
        canonical_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(signal_id) REFERENCES signal_platform_signals(signal_id),
        UNIQUE(signal_id, priority_policy_version, budget_policy_version)
      );
      CREATE INDEX IF NOT EXISTS idx_signal_platform_triage_source_outcome
        ON signal_platform_triage_decisions(source_type, outcome, decided_at, decision_id);
      CREATE INDEX IF NOT EXISTS idx_signal_platform_triage_signal
        ON signal_platform_triage_decisions(signal_id, decided_at, decision_id);

      CREATE TABLE IF NOT EXISTS signal_platform_research_work (
        work_id TEXT PRIMARY KEY,
        schema_version TEXT NOT NULL,
        signal_id TEXT NOT NULL,
        source_type TEXT NOT NULL,
        research_contract_version TEXT NOT NULL,
        priority_class TEXT NOT NULL,
        priority_score REAL NOT NULL,
        freshness_deadline TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL,
        next_attempt_at TEXT,
        lease_owner TEXT,
        lease_id TEXT,
        lease_expires_at TEXT,
        failure_category TEXT,
        failure_detail TEXT,
        attempt_started_for_lease INTEGER NOT NULL DEFAULT 0,
        trace_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        admission_json TEXT NOT NULL,
        work_json TEXT NOT NULL,
        FOREIGN KEY(signal_id) REFERENCES signal_platform_signals(signal_id),
        UNIQUE(work_id, research_contract_version)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_signal_platform_work_lease_id
        ON signal_platform_research_work(lease_id) WHERE lease_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_signal_platform_work_eligible
        ON signal_platform_research_work(
          source_type, status, priority_class, freshness_deadline,
          priority_score DESC, created_at, work_id
        );
      CREATE INDEX IF NOT EXISTS idx_signal_platform_work_retry
        ON signal_platform_research_work(source_type, status, next_attempt_at);
      CREATE INDEX IF NOT EXISTS idx_signal_platform_work_lease_expiry
        ON signal_platform_research_work(source_type, status, lease_expires_at);
      CREATE INDEX IF NOT EXISTS idx_signal_platform_work_signal
        ON signal_platform_research_work(signal_id, created_at, work_id);
      CREATE INDEX IF NOT EXISTS idx_signal_platform_work_trace
        ON signal_platform_research_work(trace_id, created_at, work_id);

      CREATE TABLE IF NOT EXISTS signal_platform_evidence (
        evidence_id TEXT PRIMARY KEY,
        schema_version TEXT NOT NULL,
        work_id TEXT NOT NULL,
        retrieved_at TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        canonical_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(work_id) REFERENCES signal_platform_research_work(work_id)
      );
      CREATE INDEX IF NOT EXISTS idx_signal_platform_evidence_work
        ON signal_platform_evidence(work_id, retrieved_at, evidence_id);

      CREATE TABLE IF NOT EXISTS signal_platform_research_packets (
        packet_id TEXT PRIMARY KEY,
        schema_version TEXT NOT NULL,
        work_id TEXT NOT NULL,
        signal_id TEXT NOT NULL,
        source_type TEXT NOT NULL,
        research_contract_version TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        canonical_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(signal_id) REFERENCES signal_platform_signals(signal_id),
        FOREIGN KEY(work_id, research_contract_version)
          REFERENCES signal_platform_research_work(work_id, research_contract_version),
        UNIQUE(work_id, research_contract_version)
      );
      CREATE INDEX IF NOT EXISTS idx_signal_platform_packets_signal
        ON signal_platform_research_packets(signal_id, created_at, packet_id);
      CREATE INDEX IF NOT EXISTS idx_signal_platform_packets_trace
        ON signal_platform_research_packets(trace_id, created_at, packet_id);
    `) } catch (error) {
      this.observeWriteFailure('initialize', error)
      throw error
    }
    this.observeWriteSuccess('initialize')
  }

  appendSignal(input: Signal): ImmutableAppendResult<Signal> {
    this.assertOpen()
    const signal = validateSignal(input)
    this.assertSource(signal.sourceType)
    const json = canonicalJson(signal)
    return this.inImmediateTransaction(() => this.appendSignalInTransaction(signal, json))
  }

  appendSignalObservation(
    input: Signal,
    observation: SignalObservationRecord,
  ): SignalObservationAppendResult {
    this.assertOpen()
    const signal = validateSignal(input)
    this.assertSource(signal.sourceType)
    this.validateObservation(observation, signal.signalId)
    return this.inImmediateTransaction(() => ({
      signal: this.appendSignalInTransaction(signal, canonicalJson(signal)),
      observation: this.appendObservationInTransaction(observation),
    }))
  }

  recordSignalObservation(input: SignalObservationRecord): ImmutableAppendResult<SignalObservationRecord> {
    this.assertOpen()
    this.assertSource(input.sourceType)
    if (!input.observationId.trim() || !input.signalId.trim() || !Number.isFinite(Date.parse(input.observedAt))) {
      throw new Error('Signal observation requires identities and a valid observedAt timestamp')
    }
    return this.inImmediateTransaction(() => {
      const signal = this.db.prepare(
        `SELECT 1 AS found FROM signal_platform_signals WHERE signal_id = ? AND source_type = ?`,
      ).get(input.signalId, input.sourceType)
      if (!signal) throw new Error(`Signal observation references unknown signal ${input.signalId}`)
      return this.appendObservationInTransaction(input)
    })
  }

  getSignal(signalId: string): Signal | null {
    return this.readJson<Signal>(
      `SELECT canonical_json FROM signal_platform_signals WHERE signal_id = ? AND source_type = ?`,
      [signalId, this.sourceType], validateSignal,
    )
  }

  findSignalByIdempotencyKey(idempotencyKey: string): Signal | null {
    return this.readJson<Signal>(
      `SELECT canonical_json FROM signal_platform_signals WHERE source_type = ? AND idempotency_key = ?`,
      [this.sourceType, idempotencyKey], validateSignal,
    )
  }

  listSignalsMissingDecision(input: {
    priorityPolicyVersion?: string
    budgetPolicyVersion?: string
    limit: number
  }): Signal[] {
    this.assertOpen()
    const clauses = ['d.signal_id = s.signal_id']
    const params: unknown[] = [this.sourceType]
    if (input.priorityPolicyVersion) {
      clauses.push('d.priority_policy_version = ?')
      params.push(input.priorityPolicyVersion)
    }
    if (input.budgetPolicyVersion) {
      clauses.push('d.budget_policy_version = ?')
      params.push(input.budgetPolicyVersion)
    }
    params.push(boundedLimit(input.limit))
    return this.readJsonList(
      `SELECT s.canonical_json FROM signal_platform_signals s
       WHERE s.source_type = ? AND NOT EXISTS (
         SELECT 1 FROM signal_platform_triage_decisions d WHERE ${clauses.join(' AND ')}
       )
       ORDER BY s.observed_at ASC, s.signal_id ASC LIMIT ?`,
      params,
      validateSignal,
    )
  }

  appendTriageDecision(input: TriageDecisionV1): ImmutableAppendResult<TriageDecisionV1> {
    this.assertOpen()
    const decision = validateTriageDecision(input)
    this.assertSource(decision.sourceType)
    if (!this.getSignal(decision.signalId)) {
      throw new Error(`Triage decision ${decision.decisionId} references an unknown source signal`)
    }
    const json = canonicalJson(decision)
    return this.inImmediateTransaction(() => {
      const existing = this.db.prepare(`
        SELECT canonical_json FROM signal_platform_triage_decisions
        WHERE decision_id = ? OR (
          signal_id = ? AND priority_policy_version = ? AND budget_policy_version = ?
        )
      `).all(
        decision.decisionId, decision.signalId,
        decision.priorityPolicyVersion, decision.budgetPolicyVersion,
      ) as Array<Record<string, unknown>>
      if (existing.length > 0) {
        if (existing.length !== 1 || existing[0]?.canonical_json !== json) {
          throw new ImmutableRecordConflictError('triage', decision.decisionId)
        }
        return { inserted: false, value: decision }
      }
      this.db.prepare(`
        INSERT INTO signal_platform_triage_decisions (
          decision_id, schema_version, signal_id, source_type, outcome,
          priority_class, priority_policy_version, budget_policy_version,
          decided_at, canonical_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        decision.decisionId, decision.schemaVersion, decision.signalId, decision.sourceType,
        decision.outcome, decision.priorityClass, decision.priorityPolicyVersion,
        decision.budgetPolicyVersion, decision.decidedAt, json, decision.decidedAt,
      )
      return { inserted: true, value: decision }
    })
  }

  getTriageDecision(decisionId: string): TriageDecisionV1 | null {
    return this.readJson(
      `SELECT canonical_json FROM signal_platform_triage_decisions
       WHERE decision_id = ? AND source_type = ?`,
      [decisionId, this.sourceType], validateTriageDecision,
    )
  }

  listTriageDecisionsBySignal(signalId: string, limit: number): TriageDecisionV1[] {
    return this.readJsonList(
      `SELECT canonical_json FROM signal_platform_triage_decisions
       WHERE signal_id = ? AND source_type = ? ORDER BY decided_at, decision_id LIMIT ?`,
      [signalId, this.sourceType, boundedLimit(limit)], validateTriageDecision,
    )
  }

  admitResearchWork(input: ResearchWorkItem): ImmutableAppendResult<ResearchWorkItem> {
    this.assertOpen()
    const work = validateResearchWorkItem(input)
    this.assertSource(work.sourceType)
    if (!this.getSignal(work.signalId)) {
      throw new Error(`Research work ${work.workId} references an unknown source signal`)
    }
    const json = canonicalJson(work)
    return this.inImmediateTransaction(() => {
      const existing = this.db.prepare(
        `SELECT admission_json FROM signal_platform_research_work WHERE work_id = ?`,
      ).get(work.workId) as Record<string, unknown> | undefined
      if (existing) {
        if (existing.admission_json !== json) throw new ImmutableRecordConflictError('work', work.workId)
        return { inserted: false, value: work }
      }
      this.db.prepare(`
        INSERT INTO signal_platform_research_work (
          work_id, schema_version, signal_id, source_type, research_contract_version,
          priority_class, priority_score, freshness_deadline, status, attempt_count,
          next_attempt_at, lease_owner, lease_id, lease_expires_at, failure_category,
          failure_detail, trace_id, created_at, updated_at, admission_json, work_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        work.workId, work.schemaVersion, work.signalId, work.sourceType, work.researchContractVersion,
        work.priorityClass, work.priorityScore, work.freshnessDeadline, work.status, work.attemptCount,
        work.nextAttemptAt, work.leaseOwner, work.leaseId, work.leaseExpiresAt, work.failureCategory,
        work.failureDetail, work.traceId, work.createdAt, work.updatedAt, json, json,
      )
      return { inserted: true, value: work }
    })
  }

  getResearchWork(workId: string): ResearchWorkItem | null {
    return this.readJson<ResearchWorkItem>(
      `SELECT work_json FROM signal_platform_research_work WHERE work_id = ? AND source_type = ?`,
      [workId, this.sourceType], validateResearchWorkItem,
    )
  }

  listResearchWorkBySignal(signalId: string, limit: number): ResearchWorkItem[] {
    return this.readJsonList(
      `SELECT work_json FROM signal_platform_research_work
       WHERE signal_id = ? AND source_type = ? ORDER BY created_at, work_id LIMIT ?`,
      [signalId, this.sourceType, boundedLimit(limit)], validateResearchWorkItem,
    )
  }

  async peekSchedulable(query: SchedulerQuery): Promise<ResearchWorkItem[]> {
    this.assertOpen()
    const statuses = statusesForStages(query.stages)
    if ((query.researchDepths && query.researchDepths.length === 0)
      || (query.priorityClasses && query.priorityClasses.length === 0)) return []
    const placeholders = statuses.map(() => '?').join(', ')
    const depthClause = query.researchDepths
      ? `AND json_extract(work_json, '$.researchDepth') IN (${query.researchDepths.map(() => '?').join(', ')})`
      : ''
    const priorityClause = query.priorityClasses
      ? `AND priority_class IN (${query.priorityClasses.map(() => '?').join(', ')})`
      : ''
    return this.readJsonList(
      `SELECT work_json FROM signal_platform_research_work
       WHERE source_type = ? AND status IN (${placeholders})
         AND freshness_deadline > ? AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         AND lease_id IS NULL
         ${depthClause}
         ${priorityClause}
       ORDER BY CASE priority_class WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END,
         freshness_deadline ASC, priority_score DESC, created_at ASC, work_id ASC
       LIMIT ?`,
      [this.sourceType, ...statuses, query.now, query.now,
        ...(query.researchDepths ?? []), ...(query.priorityClasses ?? []), boundedLimit(query.limit)],
      validateResearchWorkItem,
    )
  }

  async claimWithLease(command: LeaseCommand): Promise<WorkLease | null> {
    this.assertOpen()
    if (command.leaseExpiresAt <= command.now) throw new Error('leaseExpiresAt must be after now')
    return this.inImmediateTransaction(() => {
      const row = this.readWorkRow(command.workId)
      if (!row || row.sourceType !== this.sourceType || row.status !== command.expectedStatus
        || row.leaseId !== null || row.freshnessDeadline <= command.now
        || (row.nextAttemptAt !== null && row.nextAttemptAt > command.now)) return null
      const updated = validateResearchWorkItem({
        ...row,
        status: leasedStatusFor(command.expectedStatus),
        leaseOwner: command.leaseOwner,
        leaseId: command.leaseId,
        leaseExpiresAt: command.leaseExpiresAt,
        updatedAt: command.now,
      })
      const result = this.updateWorkWithFence(updated, `
        work_id = ? AND source_type = ? AND status = ? AND lease_id IS NULL
      `, [command.workId, this.sourceType, command.expectedStatus], 0)
      return changed(result) ? {
        work: updated,
        leaseOwner: command.leaseOwner,
        leaseId: command.leaseId,
        leaseExpiresAt: command.leaseExpiresAt,
        queuedAt: row.updatedAt,
      } : null
    })
  }

  async beginAttempt(command: BeginAttemptCommand): Promise<boolean> {
    this.assertOpen()
    return this.inImmediateTransaction(() => {
      const row = this.readWorkRow(command.workId)
      if (!row || row.sourceType !== this.sourceType || row.status !== command.expectedStatus
        || row.leaseOwner !== command.leaseOwner || row.leaseId !== command.leaseId
        || (row.leaseExpiresAt ?? '') <= command.now || this.attemptStarted(command.workId)) return false
      const updated = validateResearchWorkItem({
        ...row, attemptCount: row.attemptCount + 1, updatedAt: command.now,
      })
      return changed(this.updateWorkWithFence(updated, `
        work_id = ? AND source_type = ? AND status = ? AND lease_owner = ?
          AND lease_id = ? AND lease_expires_at > ? AND attempt_started_for_lease = 0
      `, [command.workId, this.sourceType, command.expectedStatus, command.leaseOwner,
        command.leaseId, command.now], 1))
    })
  }

  async heartbeatLease(command: HeartbeatCommand): Promise<boolean> {
    this.assertOpen()
    if (command.leaseExpiresAt <= command.now) throw new Error('leaseExpiresAt must be after now')
    return this.inImmediateTransaction(() => {
      const row = this.readWorkRow(command.workId)
      if (!row || row.sourceType !== this.sourceType || !isLeased(row.status)
        || row.leaseOwner !== command.leaseOwner || row.leaseId !== command.leaseId
        || (row.leaseExpiresAt ?? '') <= command.now) return false
      const updated = validateResearchWorkItem({
        ...row, leaseExpiresAt: command.leaseExpiresAt, updatedAt: command.now,
      })
      return changed(this.updateWorkWithFence(updated, `
        work_id = ? AND source_type = ? AND status = ? AND lease_owner = ?
          AND lease_id = ? AND lease_expires_at > ?
      `, [command.workId, this.sourceType, row.status, command.leaseOwner, command.leaseId, command.now]))
    })
  }

  async transitionLeased(command: LeasedTransitionCommand): Promise<boolean> {
    this.assertOpen()
    assertLeasedTransition(command)
    return this.inImmediateTransaction(() => {
      const row = this.readWorkRow(command.workId)
      if (!row || row.sourceType !== this.sourceType || row.status !== command.expectedStatus
        || row.leaseOwner !== command.leaseOwner || row.leaseId !== command.leaseId
        || (row.leaseExpiresAt ?? '') <= command.now) return false
      if ((command.attemptDelta ?? 0) === 1 && this.attemptStarted(command.workId)) {
        throw new Error(`Attempt already started for lease ${command.leaseId}`)
      }
      const updated = validateResearchWorkItem({
        ...row,
        status: command.nextStatus,
        attemptCount: row.attemptCount + (command.attemptDelta ?? 0),
        nextAttemptAt: command.nextAttemptAt ?? null,
        leaseOwner: null,
        leaseId: null,
        leaseExpiresAt: null,
        failureCategory: command.failureCategory ?? null,
        failureDetail: command.failureDetail ?? null,
        retryTargetStatus: command.nextStatus === 'retry_wait'
          ? pendingStatusFor(command.expectedStatus)
          : null,
        updatedAt: command.now,
      })
      return changed(this.updateWorkWithFence(updated, `
        work_id = ? AND source_type = ? AND status = ? AND lease_owner = ?
          AND lease_id = ? AND lease_expires_at > ?
      `, [command.workId, this.sourceType, command.expectedStatus, command.leaseOwner, command.leaseId, command.now], 0))
    })
  }

  async releaseLease(command: ReleaseLeaseCommand): Promise<boolean> {
    this.assertOpen()
    if (pendingStatusFor(command.expectedStatus) !== command.targetStatus) return false
    return this.inImmediateTransaction(() => {
      const row = this.readWorkRow(command.workId)
      if (!row || row.sourceType !== this.sourceType || row.status !== command.expectedStatus
        || row.leaseOwner !== command.leaseOwner || row.leaseId !== command.leaseId
        || (row.leaseExpiresAt ?? '') <= command.now) return false
      const updated = validateResearchWorkItem({
        ...row, status: command.targetStatus, leaseOwner: null, leaseId: null,
        leaseExpiresAt: null, retryTargetStatus: null, updatedAt: command.now,
      })
      return changed(this.updateWorkWithFence(updated, `
        work_id = ? AND source_type = ? AND status = ? AND lease_owner = ? AND lease_id = ?
          AND lease_expires_at > ?
      `, [command.workId, this.sourceType, command.expectedStatus, command.leaseOwner,
        command.leaseId, command.now], 0))
    })
  }

  async recoverExpiredLeases(input: { now: string; limit: number }): Promise<RecoveryResult> {
    this.assertOpen()
    return this.inImmediateTransaction(() => {
      const rows = this.db.prepare(`
        SELECT work_json FROM signal_platform_research_work
        WHERE source_type = ? AND status IN ('retrieval_leased', 'deep_leased', 'synthesis_leased', 'entity_leased')
          AND lease_expires_at <= ?
        ORDER BY lease_expires_at ASC, work_id ASC LIMIT ?
      `).all(this.sourceType, input.now, boundedLimit(input.limit)) as Array<Record<string, unknown>>
      const recovered: string[] = []
      for (const raw of rows) {
        const row = parseWork(raw.work_json)
        const updated = validateResearchWorkItem({
          ...row,
          status: pendingStatusFor(row.status as typeof LEASED_STATUSES[number]),
          leaseOwner: null,
          leaseId: null,
          leaseExpiresAt: null,
          updatedAt: input.now,
        })
        const result = this.updateWorkWithFence(updated, `
          work_id = ? AND source_type = ? AND status = ? AND lease_id = ? AND lease_expires_at <= ?
        `, [row.workId, this.sourceType, row.status, row.leaseId, input.now], 0)
        if (changed(result)) recovered.push(row.workId)
      }
      const remaining = Math.max(0, boundedLimit(input.limit) - recovered.length)
      if (remaining > 0) {
        const dueRetries = this.db.prepare(`
          SELECT work_json FROM signal_platform_research_work
          WHERE source_type = ? AND status = 'retry_wait' AND next_attempt_at <= ?
          ORDER BY next_attempt_at ASC, work_id ASC LIMIT ?
        `).all(this.sourceType, input.now, remaining) as Array<Record<string, unknown>>
        for (const raw of dueRetries) {
          const row = parseWork(raw.work_json)
          const target = row.retryTargetStatus
          if (target !== 'research_pending' && target !== 'deep_pending'
            && target !== 'synthesis_pending' && target !== 'entity_pending') continue
          const updated = validateResearchWorkItem({
            ...row,
            status: target,
            nextAttemptAt: null,
            retryTargetStatus: null,
            failureCategory: null,
            failureDetail: null,
            updatedAt: input.now,
          })
          const result = this.updateWorkWithFence(updated, `
            work_id = ? AND source_type = ? AND status = 'retry_wait'
              AND next_attempt_at <= ? AND lease_id IS NULL
          `, [row.workId, this.sourceType, input.now], 0)
          if (changed(result)) recovered.push(row.workId)
        }
      }
      return { recoveredWorkIds: recovered }
    })
  }

  async getSchedulerStatus(input: { now: string }): Promise<SchedulerAggregateStatus> {
    this.assertOpen()
    const rawCounts = this.db.prepare(`
      SELECT status, COUNT(*) AS count FROM signal_platform_research_work
      WHERE source_type = ? GROUP BY status
    `).all(this.sourceType) as Array<Record<string, unknown>>
    const byStatus: Partial<Record<WorkStatus, number>> = {}
    for (const row of rawCounts) byStatus[row.status as WorkStatus] = Number(row.count)
    const ready = this.db.prepare(`
      SELECT MIN(created_at) AS oldest FROM signal_platform_research_work
      WHERE source_type = ? AND status IN ('research_pending', 'deep_pending', 'synthesis_pending', 'entity_pending')
        AND freshness_deadline > ? AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
    `).get(this.sourceType, input.now, input.now) as Record<string, unknown> | undefined
    const lease = this.db.prepare(`
      SELECT MIN(lease_expires_at) AS oldest FROM signal_platform_research_work
      WHERE source_type = ? AND status IN ('retrieval_leased', 'deep_leased', 'synthesis_leased', 'entity_leased')
    `).get(this.sourceType) as Record<string, unknown> | undefined
    return {
      total: Object.values(byStatus).reduce((sum, count) => sum + (count ?? 0), 0),
      byStatus,
      oldestReadyAt: asNullableString(ready?.oldest),
      oldestLeaseExpiresAt: asNullableString(lease?.oldest),
    }
  }

  /** Read-only local backlog snapshot used by deterministic admission policy. */
  readTriageCapacitySnapshot(limits: TriageCapacityLimits): TriageCapacitySnapshot {
    this.assertOpen()
    const placeholders = CAPACITY_STATUSES.map(() => '?').join(', ')
    const rows = this.db.prepare(`
      SELECT priority_class, work_json FROM signal_platform_research_work
      WHERE source_type = ? AND status IN (${placeholders})
    `).all(this.sourceType, ...CAPACITY_STATUSES) as Array<Record<string, unknown>>
    const priorityCounts = { P0: 0, P1: 0, P2: 0, P3: 0 }
    const depthCounts = { light: 0, standard: 0, deep: 0 }
    for (const row of rows) {
      const priority = row.priority_class as keyof typeof priorityCounts
      if (priority in priorityCounts) priorityCounts[priority] += 1
      try {
        const work = JSON.parse(String(row.work_json)) as { researchDepth?: string }
        const depth = work.researchDepth as keyof typeof depthCounts
        if (!(depth in depthCounts)) throw new Error('unknown depth')
        depthCounts[depth] += 1
      } catch {
        throw new Error('Local triage capacity is unavailable because canonical work is invalid')
      }
    }
    const bucket = (used: number, maximum: number, reserved = 0) => {
      const boundedMaximum = Math.max(0, Math.trunc(maximum))
      const boundedReserved = Math.max(0, Math.min(boundedMaximum, Math.trunc(reserved)))
      return {
        available: Math.max(0, boundedMaximum - used),
        reservedAvailable: Math.max(0, boundedReserved - used),
        utilization: boundedMaximum === 0 ? 1 : Math.min(1, used / boundedMaximum),
      }
    }
    return {
      byPriority: {
        P0: bucket(priorityCounts.P0, limits.byPriority.P0, limits.reservedByPriority?.P0),
        P1: bucket(priorityCounts.P1, limits.byPriority.P1, limits.reservedByPriority?.P1),
        P2: bucket(priorityCounts.P2, limits.byPriority.P2, limits.reservedByPriority?.P2),
        P3: bucket(priorityCounts.P3, limits.byPriority.P3, limits.reservedByPriority?.P3),
      },
      byDepth: {
        light: bucket(depthCounts.light, limits.byDepth.light),
        standard: bucket(depthCounts.standard, limits.byDepth.standard),
        deep: bucket(depthCounts.deep, limits.byDepth.deep),
      },
    }
  }

  async readWorkObservability(
    input: Parameters<WorkObservabilityReadPort['readWorkObservability']>[0],
  ): ReturnType<WorkObservabilityReadPort['readWorkObservability']> {
    this.assertOpen()
    const intake = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM signal_platform_signals WHERE source_type = ?) AS signal_count,
        (SELECT COUNT(*) FROM signal_platform_triage_decisions WHERE source_type = ?) AS triage_decision_count,
        (SELECT COUNT(*) FROM signal_platform_signal_observations WHERE source_type = ?) AS observation_count,
        (SELECT COUNT(*) FROM signal_platform_signal_observations
          WHERE source_type = ? AND deduplicated = 1) AS deduplicated_count
    `).get(this.sourceType, this.sourceType, this.sourceType, this.sourceType) as Record<string, unknown> | undefined
    const triageOutcomes = this.db.prepare(`
      SELECT outcome, COUNT(*) AS count
      FROM signal_platform_triage_decisions WHERE source_type = ?
      GROUP BY outcome ORDER BY outcome
    `).all(this.sourceType) as Array<Record<string, unknown>>
    const artifacts = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM signal_platform_research_packets WHERE source_type = ?) AS packet_count,
        (SELECT COUNT(*) FROM signal_platform_research_work
          WHERE source_type = ? AND status = 'complete') AS entity_memory_handoff_count
    `).get(this.sourceType, this.sourceType) as Record<string, unknown> | undefined
    const attempt = this.db.prepare(`
      SELECT COALESCE(SUM(attempt_count), 0) AS total_attempts,
        SUM(CASE WHEN attempt_count > 0 THEN 1 ELSE 0 END) AS attempted_items,
        COALESCE(MAX(attempt_count), 0) AS max_attempt_count
      FROM signal_platform_research_work WHERE source_type = ?
    `).get(this.sourceType) as Record<string, unknown> | undefined
    const failures = this.db.prepare(`
      SELECT failure_category, COUNT(*) AS count, MAX(updated_at) AS last_occurred_at
      FROM signal_platform_research_work
      WHERE source_type = ? AND failure_category IS NOT NULL AND updated_at >= ?
      GROUP BY failure_category
      ORDER BY last_occurred_at DESC, failure_category ASC LIMIT ?
    `).all(
      this.sourceType, input.recentFailureSince, boundedLimit(input.failureLimit),
    ) as Array<Record<string, unknown>>
    const activity = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM signal_platform_signal_observations
          WHERE source_type = ? AND observed_at >= ? AND observed_at <= ?) AS arrivals,
        (SELECT COUNT(*) FROM signal_platform_research_work
          WHERE source_type = ? AND created_at >= ? AND created_at <= ?) AS admissions,
        (SELECT COUNT(*) FROM signal_platform_research_packets
          WHERE source_type = ? AND created_at >= ? AND created_at <= ?) AS completions
    `).get(
      this.sourceType, input.activitySince ?? input.recentFailureSince, input.now,
      this.sourceType, input.activitySince ?? input.recentFailureSince, input.now,
      this.sourceType, input.activitySince ?? input.recentFailureSince, input.now,
    ) as Record<string, unknown> | undefined
    const queueAge = this.db.prepare(`
      WITH ages AS (
        SELECT priority_class, json_extract(work_json, '$.researchDepth') AS research_depth,
          status, updated_at,
          MAX(0, ROUND((julianday(?) - julianday(updated_at)) * 86400000)) AS age_ms
        FROM signal_platform_research_work
        WHERE source_type = ?
          AND status IN ('research_pending', 'deep_pending', 'synthesis_pending', 'entity_pending', 'retry_wait')
      ), ranked AS (
        SELECT *,
          ROW_NUMBER() OVER (PARTITION BY priority_class, research_depth, status ORDER BY age_ms) AS rank,
          COUNT(*) OVER (PARTITION BY priority_class, research_depth, status) AS group_count
        FROM ages
      )
      SELECT priority_class, research_depth, status, MAX(group_count) AS count,
        MIN(updated_at) AS oldest_queued_at,
        MAX(CASE WHEN rank = CAST((group_count * 50 + 99) / 100 AS INTEGER) THEN age_ms END) AS p50_age_ms,
        MAX(CASE WHEN rank = CAST((group_count * 95 + 99) / 100 AS INTEGER) THEN age_ms END) AS p95_age_ms
      FROM ranked GROUP BY priority_class, research_depth, status
      ORDER BY priority_class, research_depth, status
    `).all(input.now, this.sourceType) as Array<Record<string, unknown>>
    const endToEnd = this.db.prepare(`
      WITH latencies AS (
        SELECT MAX(0, ROUND((julianday(w.updated_at) - julianday(s.observed_at)) * 86400000)) AS latency_ms
        FROM signal_platform_research_work w
        JOIN signal_platform_signals s ON s.signal_id = w.signal_id
        WHERE w.source_type = ? AND w.status = 'complete'
      ), ranked AS (
        SELECT latency_ms, ROW_NUMBER() OVER (ORDER BY latency_ms) AS rank, COUNT(*) OVER () AS total
        FROM latencies
      )
      SELECT COUNT(*) AS sample_count,
        MAX(CASE WHEN rank = CAST((total * 50 + 99) / 100 AS INTEGER) THEN latency_ms END) AS p50_ms,
        MAX(CASE WHEN rank = CAST((total * 95 + 99) / 100 AS INTEGER) THEN latency_ms END) AS p95_ms,
        MAX(CASE WHEN rank = CAST((total * 99 + 99) / 100 AS INTEGER) THEN latency_ms END) AS p99_ms
      FROM ranked
    `).get(this.sourceType) as Record<string, unknown> | undefined
    const deadLetterSummary = this.db.prepare(`
      SELECT COUNT(*) AS count, MIN(updated_at) AS oldest_at
      FROM signal_platform_research_work WHERE source_type = ? AND status = 'dead_letter'
    `).get(this.sourceType) as Record<string, unknown> | undefined
    const deadLetterCategories = this.db.prepare(`
      SELECT failure_category, COUNT(*) AS count, MAX(updated_at) AS last_occurred_at
      FROM signal_platform_research_work
      WHERE source_type = ? AND status = 'dead_letter' AND failure_category IS NOT NULL
      GROUP BY failure_category ORDER BY count DESC, failure_category ASC
    `).all(this.sourceType) as Array<Record<string, unknown>>
    return Promise.resolve({
      signalCount: Number(intake?.signal_count ?? 0),
      observationCount: Number(intake?.observation_count ?? 0),
      deduplicatedObservationCount: Number(intake?.deduplicated_count ?? 0),
      triageDecisionCount: Number(intake?.triage_decision_count ?? 0),
      triageOutcomes: Object.fromEntries(
        triageOutcomes.map((row) => [String(row.outcome), Number(row.count ?? 0)]),
      ),
      researchPacketCount: Number(artifacts?.packet_count ?? 0),
      entityMemoryHandoffCount: Number(artifacts?.entity_memory_handoff_count ?? 0),
      endToEndLatency: {
        sampleCount: Number(endToEnd?.sample_count ?? 0),
        p50Ms: nullableNumber(endToEnd?.p50_ms),
        p95Ms: nullableNumber(endToEnd?.p95_ms),
        p99Ms: nullableNumber(endToEnd?.p99_ms),
      },
      sqliteSize: sqliteSize(this.databasePath),
      sqliteStoreId: this.storeId,
      sqliteWriteErrors: this.writeHealthJournal?.readCoverage({
        sourceType: this.sourceType,
        storeId: this.storeId,
        since: input.recentFailureSince,
        now: input.now,
        staleAfterMs: this.writeHealthStaleAfterMs,
      }) ?? {
        availability: 'unavailable' as const,
        value: null,
        measuredCount: 0,
        reason: 'No durable SQLite write-health journal is configured',
      },
      totalAttempts: Number(attempt?.total_attempts ?? 0),
      attemptedItems: Number(attempt?.attempted_items ?? 0),
      maxAttemptCount: Number(attempt?.max_attempt_count ?? 0),
      arrivalsInWindow: Number(activity?.arrivals ?? 0),
      admissionsInWindow: Number(activity?.admissions ?? 0),
      completionsInWindow: Number(activity?.completions ?? 0),
      queueAge: queueAge.map((row) => ({
        priorityClass: row.priority_class as ResearchWorkItem['priorityClass'],
        researchDepth: row.research_depth as ResearchWorkItem['researchDepth'],
        status: row.status as WorkStatus,
        count: Number(row.count ?? 0),
        oldestQueuedAt: String(row.oldest_queued_at),
        p50AgeMs: Number(row.p50_age_ms ?? 0),
        p95AgeMs: Number(row.p95_age_ms ?? 0),
      })),
      deadLetters: {
        total: Number(deadLetterSummary?.count ?? 0),
        oldestAt: asNullableString(deadLetterSummary?.oldest_at),
        byFailureCategory: deadLetterCategories.map((row) => ({
          category: row.failure_category as FailureCategory,
          count: Number(row.count ?? 0),
          lastOccurredAt: asNullableString(row.last_occurred_at),
        })),
      },
      recentFailures: failures.map((row) => ({
        category: row.failure_category as FailureCategory,
        count: Number(row.count ?? 0),
        lastOccurredAt: asNullableString(row.last_occurred_at),
      })),
    })
  }

  appendEvidence(input: RetrievedEvidence): ImmutableAppendResult<RetrievedEvidence> {
    this.assertOpen()
    const evidence = validateRetrievedEvidence(input)
    if (!this.getResearchWork(evidence.workId)) {
      throw new Error(`Evidence ${evidence.evidenceId} references unknown work for ${this.sourceType}`)
    }
    return this.appendImmutable(
      'evidence', evidence.evidenceId, canonicalJson(evidence),
      `SELECT canonical_json FROM signal_platform_evidence WHERE evidence_id = ?`,
      `INSERT INTO signal_platform_evidence (
        evidence_id, schema_version, work_id, retrieved_at, content_hash, canonical_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [evidence.evidenceId, evidence.schemaVersion, evidence.workId, evidence.retrievedAt,
        evidence.contentHash, canonicalJson(evidence), evidence.retrievedAt],
      evidence,
    )
  }

  getEvidence(evidenceId: string): RetrievedEvidence | null {
    return this.readJson(
      `SELECT e.canonical_json FROM signal_platform_evidence e
       JOIN signal_platform_research_work w ON w.work_id = e.work_id
       WHERE e.evidence_id = ? AND w.source_type = ?`,
      [evidenceId, this.sourceType], validateRetrievedEvidence,
    )
  }

  listEvidenceByWork(workId: string, limit: number): RetrievedEvidence[] {
    return this.readJsonList(
      `SELECT e.canonical_json FROM signal_platform_evidence e
       JOIN signal_platform_research_work w ON w.work_id = e.work_id
       WHERE e.work_id = ? AND w.source_type = ?
       ORDER BY e.retrieved_at, e.evidence_id LIMIT ?`,
      [workId, this.sourceType, boundedLimit(limit)], validateRetrievedEvidence,
    )
  }

  appendResearchPacket(input: ResearchPacketV1): ImmutableAppendResult<ResearchPacketV1> {
    this.assertOpen()
    const packet = validateResearchPacket(input)
    this.assertSource(packet.sourceType)
    const work = this.getResearchWork(packet.workId)
    if (!work || work.signalId !== packet.signalId
      || work.researchContractVersion !== packet.researchContractVersion) {
      throw new Error(`Packet ${packet.packetId} does not match its work/signal/contract linkage`)
    }
    const json = canonicalJson(packet)
    return this.appendImmutable(
      'packet', packet.packetId, json,
      `SELECT canonical_json FROM signal_platform_research_packets
       WHERE packet_id = ? OR (work_id = ? AND research_contract_version = ?)`,
      `INSERT INTO signal_platform_research_packets (
        packet_id, schema_version, work_id, signal_id, source_type,
        research_contract_version, trace_id, canonical_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [packet.packetId, packet.schemaVersion, packet.workId, packet.signalId, packet.sourceType,
        packet.researchContractVersion, packet.execution.traceId, json, packet.createdAt],
      packet,
      [packet.packetId, packet.workId, packet.researchContractVersion],
    )
  }

  getResearchPacket(packetId: string): ResearchPacketV1 | null {
    return this.readJson(
      `SELECT canonical_json FROM signal_platform_research_packets WHERE packet_id = ? AND source_type = ?`,
      [packetId, this.sourceType], validateResearchPacket,
    )
  }

  listResearchPacketsByWork(workId: string, limit: number): ResearchPacketV1[] {
    return this.listPackets('work_id = ?', [workId], limit)
  }

  listResearchPacketsBySignal(signalId: string, limit: number): ResearchPacketV1[] {
    return this.listPackets('signal_id = ?', [signalId], limit)
  }

  listResearchPacketsByTrace(traceId: string, limit: number): ResearchPacketV1[] {
    return this.listPackets('trace_id = ?', [traceId], limit)
  }

  promoteResearchReady(workId: string, now: string): boolean {
    this.assertOpen()
    return this.inImmediateTransaction(() => {
      const row = this.readWorkRow(workId)
      if (!row || row.sourceType !== this.sourceType || row.status !== 'research_ready'
        || row.leaseId !== null) return false
      const updated = validateResearchWorkItem({
        ...row,
        status: 'entity_pending',
        nextAttemptAt: null,
        retryTargetStatus: null,
        failureCategory: null,
        failureDetail: null,
        updatedAt: now,
      })
      return changed(this.updateWorkWithFence(updated, `
        work_id = ? AND source_type = ? AND status = 'research_ready' AND lease_id IS NULL
      `, [workId, this.sourceType], 0))
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  private listPackets(predicate: string, params: unknown[], limit: number): ResearchPacketV1[] {
    return this.readJsonList(
      `SELECT canonical_json FROM signal_platform_research_packets
       WHERE source_type = ? AND ${predicate} ORDER BY created_at, packet_id LIMIT ?`,
      [this.sourceType, ...params, boundedLimit(limit)], validateResearchPacket,
    )
  }

  private appendSignalInTransaction(signal: Signal, json: string): ImmutableAppendResult<Signal> {
    const matches = this.db.prepare(`
      SELECT signal_id, canonical_json FROM signal_platform_signals
      WHERE signal_id = ? OR (source_type = ? AND idempotency_key = ?)
    `).all(signal.signalId, signal.sourceType, signal.idempotencyKey) as Array<Record<string, unknown>>
    if (matches.length > 0) {
      if (matches.length !== 1 || matches[0]?.canonical_json !== json) {
        throw new ImmutableRecordConflictError('signal', `${signal.signalId}/${signal.idempotencyKey}`)
      }
      return { inserted: false, value: signal }
    }
    this.db.prepare(`
      INSERT INTO signal_platform_signals (
        signal_id, schema_version, source_type, source_id, idempotency_key,
        observed_at, canonical_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      signal.signalId, signal.schemaVersion, signal.sourceType, signal.sourceId,
      signal.idempotencyKey, signal.observedAt, json, signal.observedAt,
    )
    return { inserted: true, value: signal }
  }

  private appendObservationInTransaction(
    input: SignalObservationRecord,
  ): ImmutableAppendResult<SignalObservationRecord> {
    const row = this.db.prepare(`
      SELECT signal_id, source_type, observed_at, deduplicated
      FROM signal_platform_signal_observations WHERE observation_id = ?
    `).get(input.observationId) as Record<string, unknown> | undefined
    if (row) {
      const same = row.signal_id === input.signalId && row.source_type === input.sourceType
        && row.observed_at === input.observedAt
      if (!same) throw new ImmutableRecordConflictError('signal', input.observationId)
      return {
        inserted: false,
        value: { ...input, deduplicated: Number(row.deduplicated) === 1 },
      }
    }
    this.db.prepare(`
      INSERT INTO signal_platform_signal_observations (
        observation_id, signal_id, source_type, observed_at, deduplicated, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.observationId, input.signalId, input.sourceType, input.observedAt,
      input.deduplicated ? 1 : 0, input.observedAt,
    )
    return { inserted: true, value: input }
  }

  private validateObservation(input: SignalObservationRecord, expectedSignalId?: string): void {
    this.assertSource(input.sourceType)
    if (!input.observationId.trim() || !input.signalId.trim() || !Number.isFinite(Date.parse(input.observedAt))) {
      throw new Error('Signal observation requires identities and a valid observedAt timestamp')
    }
    if (expectedSignalId && input.signalId !== expectedSignalId) {
      throw new Error('Signal observation must reference the atomically appended Signal')
    }
  }

  private appendImmutable<T>(
    kind: 'evidence' | 'packet', identity: string, json: string,
    selectSql: string, insertSql: string, insertParams: unknown[], value: T,
    selectParams: unknown[] = [identity],
  ): ImmutableAppendResult<T> {
    return this.inImmediateTransaction(() => {
      const existing = this.db.prepare(selectSql).all(...selectParams) as Array<Record<string, unknown>>
      if (existing.length > 0) {
        if (existing.length !== 1 || existing[0]?.canonical_json !== json) {
          throw new ImmutableRecordConflictError(kind, identity)
        }
        return { inserted: false, value }
      }
      this.db.prepare(insertSql).run(...insertParams)
      return { inserted: true, value }
    })
  }

  private readWorkRow(workId: string): ResearchWorkItem | null {
    const raw = this.db.prepare(
      `SELECT work_json FROM signal_platform_research_work WHERE work_id = ?`,
    ).get(workId) as Record<string, unknown> | undefined
    return raw ? parseWork(raw.work_json) : null
  }

  private updateWorkWithFence(
    work: ResearchWorkItem,
    where: string,
    params: unknown[],
    attemptStartedForLease: 0 | 1 | null = null,
  ): SqliteRunResult {
    return this.db.prepare(`
      UPDATE signal_platform_research_work SET
        status = ?, attempt_count = ?, next_attempt_at = ?, lease_owner = ?, lease_id = ?,
        lease_expires_at = ?, failure_category = ?, failure_detail = ?, updated_at = ?, work_json = ?,
        attempt_started_for_lease = COALESCE(?, attempt_started_for_lease)
      WHERE ${where}
    `).run(
      work.status, work.attemptCount, work.nextAttemptAt, work.leaseOwner, work.leaseId,
      work.leaseExpiresAt, work.failureCategory, work.failureDetail, work.updatedAt,
      canonicalJson(work), attemptStartedForLease, ...params,
    )
  }

  private attemptStarted(workId: string): boolean {
    const row = this.db.prepare(`
      SELECT attempt_started_for_lease FROM signal_platform_research_work WHERE work_id = ?
    `).get(workId) as Record<string, unknown> | undefined
    return Number(row?.attempt_started_for_lease) === 1
  }

  private readJson<T>(
    sql: string, params: unknown[], validate: (value: unknown) => T,
  ): T | null {
    this.assertOpen()
    const row = this.db.prepare(sql).get(...params) as Record<string, unknown> | undefined
    return row ? parseJson(row.canonical_json ?? row.work_json, validate) : null
  }

  private readJsonList<T>(
    sql: string, params: unknown[], validate: (value: unknown) => T,
  ): T[] {
    this.assertOpen()
    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>
    return rows.map((row) => parseJson(row.canonical_json ?? row.work_json, validate))
  }

  private inImmediateTransaction<T>(action: () => T): T {
    try {
      this.db.exec('BEGIN IMMEDIATE')
    } catch (error) {
      this.observeWriteFailure('begin_immediate', error)
      throw error
    }
    try {
      const result = action()
      this.db.exec('COMMIT')
      this.observeWriteSuccess('commit')
      return result
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch (rollbackError) {
        this.observeWriteFailure('rollback', rollbackError)
      }
      this.observeWriteFailure('transaction', error)
      throw error
    }
  }

  private observeWriteSuccess(operation: string): void {
    try {
      this.writeHealthJournal?.observeSuccess({ sourceType: this.sourceType, storeId: this.storeId, operation })
    } catch { /* health journaling must never change a successful queue result */ }
  }

  private observeWriteFailure(operation: string, error: unknown): void {
    try {
      this.writeHealthJournal?.observeFailure({ sourceType: this.sourceType, storeId: this.storeId, operation, error })
    } catch { /* preserve the authoritative SQLite failure */ }
  }

  private assertSource(sourceType: Signal['sourceType']): void {
    if (sourceType !== this.sourceType) {
      throw new Error(`Store sourceType ${this.sourceType} cannot persist ${sourceType}`)
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('SqliteSignalPlatformStore is closed')
  }
}

function parseWork(value: unknown): ResearchWorkItem {
  return parseJson(value, validateResearchWorkItem)
}

function parseJson<T>(value: unknown, validate: (input: unknown) => T): T {
  if (typeof value !== 'string') throw new Error('Canonical store contains non-string JSON')
  return validate(JSON.parse(value))
}

function changed(result: SqliteRunResult): boolean {
  return Number(result.changes) === 1
}

function isLeased(status: WorkStatus): status is typeof LEASED_STATUSES[number] {
  return (LEASED_STATUSES as readonly WorkStatus[]).includes(status)
}

function statusesForStages(stages?: SchedulerQuery['stages']): readonly typeof PENDING_STATUSES[number][] {
  if (!stages || stages.length === 0) return PENDING_STATUSES
  return stages.map((stage) => stage === 'retrieval'
    ? 'research_pending' : stage === 'deep' ? 'deep_pending'
      : stage === 'synthesis' ? 'synthesis_pending' : 'entity_pending')
}

function boundedLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit <= 0) throw new Error('limit must be a positive integer')
  return Math.min(limit, 1000)
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function sqliteSize(path: string): {
  mainBytes: number
  walBytes: number
  shmBytes: number
  totalBytes: number
} {
  const bytes = (candidate: string): number => {
    try { return statSync(candidate).size } catch { return 0 }
  }
  const mainBytes = bytes(path)
  const walBytes = bytes(`${path}-wal`)
  const shmBytes = bytes(`${path}-shm`)
  return { mainBytes, walBytes, shmBytes, totalBytes: mainBytes + walBytes + shmBytes }
}
