import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { canonicalJson } from '../signal-platform/canonical-json'
import { InferenceGatewayError } from './errors'
import type {
  ClassificationAttemptRecord,
  ClassificationAuditSink,
  ClassificationCapacityCoordinator,
  ClassificationLease,
  ClassificationPolicyOutcomeRecord,
  ClassificationShadowEnvelope,
  ClassificationShadowOutbox,
} from './classification-types'
import type { InferenceProviderTarget } from './types'

interface Statement {
  run(...params: unknown[]): { changes: number | bigint }
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}
interface Database { exec(sql: string): void; prepare(sql: string): Statement; close(): void }
const nodeRequire = createRequire(__filename)
const { DatabaseSync } = nodeRequire('node:sqlite') as { DatabaseSync: new(path: string) => Database }

export interface ClaimedClassificationShadow {
  envelope: ClassificationShadowEnvelope
  leaseToken: string
  attempt: number
}

export interface ClassificationShadowRetentionPolicy {
  terminalRetentionMs: number
  maxRows: number
  maxBytes: number
}

export const DEFAULT_CLASSIFICATION_SHADOW_RETENTION = Object.freeze({
  terminalRetentionMs: 7 * 24 * 60 * 60_000,
  maxRows: 10_000,
  maxBytes: 64 * 1024 * 1024,
})

export interface ClassificationShadowOutboxStats {
  rows: number
  bytes: number
  pending: number
  leased: number
  terminal: number
}

/**
 * One crash-safe SQLite control plane shared by every PM2 process on the VPS.
 * It owns capacity leases, provider circuit/rate state, immutable audit rows,
 * and the best-effort shadow outbox.
 */
export class SqliteClassificationControlPlane implements
ClassificationCapacityCoordinator, ClassificationAuditSink, ClassificationShadowOutbox {
  private readonly db: Database
  private readonly now: () => number
  private readonly shadowRetention: ClassificationShadowRetentionPolicy
  private closed = false

  constructor(path: string, options: {
    now?: () => number
    shadowRetention?: Partial<ClassificationShadowRetentionPolicy>
  } = {}) {
    const resolved = resolve(path)
    mkdirSync(dirname(resolved), { recursive: true })
    this.db = new DatabaseSync(resolved)
    this.now = options.now ?? Date.now
    this.shadowRetention = retentionPolicy(options.shadowRetention)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS classification_capacity_leases (
        token TEXT PRIMARY KEY,
        workload TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        lane TEXT NOT NULL CHECK (lane IN ('live', 'shadow')),
        expires_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_classification_capacity_target
        ON classification_capacity_leases(provider, model, lane, expires_at_ms);
      CREATE TABLE IF NOT EXISTS classification_rate_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workload TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        lane TEXT NOT NULL CHECK (lane IN ('live', 'shadow')),
        occurred_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_classification_rate_window
        ON classification_rate_events(workload, provider, model, occurred_at_ms);
      CREATE TABLE IF NOT EXISTS classification_circuits (
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        failure_count INTEGER NOT NULL DEFAULT 0,
        open_until_ms INTEGER,
        probe_token TEXT,
        PRIMARY KEY(provider, model)
      );
      CREATE TABLE IF NOT EXISTS classification_attempts (
        decision_id TEXT NOT NULL,
        execution_mode TEXT NOT NULL CHECK (execution_mode IN ('authoritative', 'shadow')),
        attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
        workload TEXT NOT NULL,
        decision_version TEXT NOT NULL,
        status TEXT NOT NULL,
        canonical_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(decision_id, execution_mode, attempt_number)
      );
      CREATE TABLE IF NOT EXISTS classification_policy_outcomes (
        decision_id TEXT NOT NULL,
        consumer TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        canonical_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(decision_id, consumer, policy_version)
      );
      CREATE TABLE IF NOT EXISTS classification_shadow_outbox (
        decision_id TEXT PRIMARY KEY,
        workload TEXT NOT NULL,
        decision_version TEXT NOT NULL,
        state_digest TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'leased', 'completed', 'failed')),
        attempt INTEGER NOT NULL DEFAULT 0,
        available_at_ms INTEGER NOT NULL,
        lease_token TEXT,
        lease_expires_at_ms INTEGER,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_classification_shadow_ready
        ON classification_shadow_outbox(status, available_at_ms, lease_expires_at_ms);
    `)
    migrateClassificationAttempts(this.db)
    const rateColumns = this.db.prepare('PRAGMA table_info(classification_rate_events)').all() as Array<{ name?: unknown }>
    if (!rateColumns.some((column) => column.name === 'lane')) {
      this.db.exec("ALTER TABLE classification_rate_events ADD COLUMN lane TEXT NOT NULL DEFAULT 'live' CHECK (lane IN ('live', 'shadow'));")
    }
    this.db.exec(`
      DROP INDEX IF EXISTS idx_classification_capacity_target;
      CREATE INDEX idx_classification_capacity_target
        ON classification_capacity_leases(provider, model, lane, expires_at_ms);
      DROP INDEX IF EXISTS idx_classification_rate_window;
      CREATE INDEX idx_classification_rate_window
        ON classification_rate_events(provider, model, lane, occurred_at_ms);
      CREATE INDEX IF NOT EXISTS idx_classification_rate_workload_window
        ON classification_rate_events(workload, provider, model, lane, occurred_at_ms);
    `)
  }

  acquire(input: Parameters<ClassificationCapacityCoordinator['acquire']>[0]): ClassificationLease {
    this.assertOpen()
    const now = this.now()
    const token = randomUUID()
    const { workload, target, mode, policy } = input
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM classification_capacity_leases WHERE expires_at_ms <= ?').run(now)
      this.db.prepare(`UPDATE classification_circuits SET probe_token = NULL
        WHERE probe_token IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM classification_capacity_leases AS lease
          WHERE lease.token = classification_circuits.probe_token
        )`).run()
      this.db.prepare('DELETE FROM classification_rate_events WHERE occurred_at_ms <= ?').run(now - 86_400_000)
      const circuit = this.db.prepare(`
        SELECT failure_count, open_until_ms, probe_token FROM classification_circuits
        WHERE provider = ? AND model = ?
      `).get(target.provider, target.model) as {
        failure_count: number; open_until_ms: number | null; probe_token: string | null
      } | undefined
      if (circuit?.open_until_ms !== null && circuit?.open_until_ms !== undefined) {
        if (circuit.open_until_ms > now || circuit.probe_token !== null) {
          throw new InferenceGatewayError('Classification provider circuit is open', {
            category: 'circuit_open', retryable: true,
            retryAfterMs: Math.max(1, circuit.open_until_ms - now),
            provider: target.provider, model: target.model,
          })
        }
        this.db.prepare(`UPDATE classification_circuits SET probe_token = ?
          WHERE provider = ? AND model = ?`).run(token, target.provider, target.model)
      }
      const concurrencyLimit = mode === 'live' ? policy.liveConcurrency : policy.shadowConcurrency
      const active = this.db.prepare(`
        SELECT COUNT(*) AS count FROM classification_capacity_leases
        WHERE provider = ? AND model = ? AND lane = ? AND expires_at_ms > ?
      `).get(target.provider, target.model, mode, now) as { count: number }
      if (active.count >= concurrencyLimit) {
        throw new InferenceGatewayError('Classification concurrency limit reached', {
          category: 'provider_rate_limited', retryable: true, retryAfterMs: 250,
          provider: target.provider, model: target.model,
        })
      }
      const providerRecent = this.db.prepare(`
        SELECT COUNT(*) AS count, MIN(occurred_at_ms) AS oldest
        FROM classification_rate_events WHERE provider = ? AND model = ?
          AND lane = ? AND occurred_at_ms > ?
      `).get(target.provider, target.model, mode, now - policy.windowMs) as { count: number; oldest: number | null }
      if (providerRecent.count >= policy.providerMaxCalls) {
        throw new InferenceGatewayError('Classification provider-global rate limit reached', {
          category: 'provider_rate_limited', retryable: true,
          retryAfterMs: Math.max(1, policy.windowMs - (now - (providerRecent.oldest ?? now))),
          provider: target.provider, model: target.model,
        })
      }
      const workloadRecent = this.db.prepare(`
        SELECT COUNT(*) AS count, MIN(occurred_at_ms) AS oldest
        FROM classification_rate_events WHERE workload = ? AND provider = ? AND model = ?
          AND lane = ? AND occurred_at_ms > ?
      `).get(workload, target.provider, target.model, mode, now - policy.windowMs) as { count: number; oldest: number | null }
      if (workloadRecent.count >= policy.workloadMaxCalls) {
        throw new InferenceGatewayError('Classification workload rate limit reached', {
          category: 'provider_rate_limited', retryable: true,
          retryAfterMs: Math.max(1, policy.windowMs - (now - (workloadRecent.oldest ?? now))),
          provider: target.provider, model: target.model,
        })
      }
      this.db.prepare(`INSERT INTO classification_capacity_leases
        (token, workload, provider, model, lane, expires_at_ms) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(token, workload, target.provider, target.model, mode, now + policy.leaseMs)
      this.db.prepare(`INSERT INTO classification_rate_events
        (workload, provider, model, lane, occurred_at_ms) VALUES (?, ?, ?, ?, ?)`)
        .run(workload, target.provider, target.model, mode, now)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    let released = false
    return {
      token,
      release: ({ success, retryableFailure }) => {
        if (released) return
        released = true
        this.releaseLease(token, target, policy.circuitFailureThreshold, policy.circuitCooldownMs, success, retryableFailure)
      },
    }
  }

  recordAttempt(record: ClassificationAttemptRecord): void {
    this.assertOpen()
    const encoded = canonicalJson(record)
    const result = this.db.prepare(`INSERT OR IGNORE INTO classification_attempts
      (decision_id, execution_mode, attempt_number, workload, decision_version, status, canonical_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(record.decisionId, record.executionMode, record.attemptNumber, record.workload, record.decisionVersion,
        record.status, encoded, record.finishedAt)
    if (Number(result.changes) === 0) {
      this.assertSameAttempt(record.decisionId, record.executionMode, record.attemptNumber, encoded)
    }
  }

  getAttempt(
    decisionId: string,
    executionMode: 'authoritative' | 'shadow',
    attemptNumber?: number,
  ): ClassificationAttemptRecord | null {
    this.assertOpen()
    const row = this.db.prepare(`SELECT canonical_json FROM classification_attempts
      WHERE decision_id = ? AND execution_mode = ?
        AND (? IS NULL OR attempt_number = ?)
      ORDER BY attempt_number DESC LIMIT 1`).get(
      decisionId, executionMode, attemptNumber ?? null, attemptNumber ?? null,
    ) as {
        canonical_json: string
      } | undefined
    return row ? JSON.parse(row.canonical_json) as ClassificationAttemptRecord : null
  }

  recordPolicyOutcome(record: ClassificationPolicyOutcomeRecord): void {
    this.assertOpen()
    const encoded = canonicalJson(record)
    const result = this.db.prepare(`INSERT OR IGNORE INTO classification_policy_outcomes
      (decision_id, consumer, policy_version, canonical_json, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(record.decisionId, record.consumer, record.policyVersion, encoded, record.recordedAt)
    if (Number(result.changes) === 0) {
      const row = this.db.prepare(`SELECT canonical_json FROM classification_policy_outcomes
        WHERE decision_id = ? AND consumer = ? AND policy_version = ?`)
        .get(record.decisionId, record.consumer, record.policyVersion) as { canonical_json: string }
      if (row.canonical_json !== encoded) throw new Error(`Conflicting classification policy outcome ${record.decisionId}`)
    }
  }

  enqueue(value: ClassificationShadowEnvelope): void {
    this.assertOpen()
    enqueueShadow(this.db, value, this.now(), this.shadowRetention)
  }

  claimShadow(leaseMs = 60_000): ClaimedClassificationShadow | null {
    this.assertOpen()
    const now = this.now()
    const token = randomUUID()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`UPDATE classification_shadow_outbox
        SET status = 'pending', lease_token = NULL, lease_expires_at_ms = NULL, updated_at = ?
        WHERE status = 'leased' AND lease_expires_at_ms <= ?`).run(new Date(now).toISOString(), now)
      const row = this.db.prepare(`SELECT decision_id, envelope_json, attempt
        FROM classification_shadow_outbox WHERE status = 'pending' AND available_at_ms <= ?
        ORDER BY available_at_ms, decision_id LIMIT 1`).get(now) as {
          decision_id: string; envelope_json: string; attempt: number
        } | undefined
      if (!row) {
        this.db.exec('COMMIT')
        return null
      }
      this.db.prepare(`UPDATE classification_shadow_outbox SET status = 'leased', attempt = attempt + 1,
        lease_token = ?, lease_expires_at_ms = ?, updated_at = ? WHERE decision_id = ?`)
        .run(token, now + leaseMs, new Date(now).toISOString(), row.decision_id)
      this.db.exec('COMMIT')
      return { envelope: parseEnvelope(row.envelope_json), leaseToken: token, attempt: row.attempt + 1 }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  completeShadow(decisionId: string, leaseToken: string): void {
    this.finishShadow(decisionId, leaseToken, 'completed', null, this.now())
    this.pruneShadowOutbox()
  }

  failShadow(decisionId: string, leaseToken: string, error: string, retryAtMs: number | null): void {
    this.finishShadow(decisionId, leaseToken, retryAtMs === null ? 'failed' : 'pending', error.slice(0, 1_000), retryAtMs ?? this.now())
    if (retryAtMs === null) this.pruneShadowOutbox()
  }

  pruneShadowOutbox(): void {
    this.assertOpen()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      pruneShadowRows(this.db, this.now(), this.shadowRetention, 0, 0)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  shadowOutboxStats(): ClassificationShadowOutboxStats {
    this.assertOpen()
    return shadowStats(this.db)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  private releaseLease(
    token: string,
    target: InferenceProviderTarget,
    threshold: number,
    cooldownMs: number,
    success: boolean,
    retryableFailure: boolean,
  ): void {
    const now = this.now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM classification_capacity_leases WHERE token = ?').run(token)
      const row = this.db.prepare(`SELECT failure_count, probe_token FROM classification_circuits
        WHERE provider = ? AND model = ?`).get(target.provider, target.model) as {
          failure_count: number; probe_token: string | null
        } | undefined
      if (success || !retryableFailure) {
        this.db.prepare(`INSERT INTO classification_circuits(provider, model, failure_count, open_until_ms, probe_token)
          VALUES (?, ?, 0, NULL, NULL) ON CONFLICT(provider, model) DO UPDATE SET
          failure_count = 0, open_until_ms = NULL, probe_token = NULL`).run(target.provider, target.model)
      } else {
        const failures = (row?.failure_count ?? 0) + 1
        const open = row?.probe_token === token || failures >= threshold
        this.db.prepare(`INSERT INTO classification_circuits(provider, model, failure_count, open_until_ms, probe_token)
          VALUES (?, ?, ?, ?, NULL) ON CONFLICT(provider, model) DO UPDATE SET
          failure_count = excluded.failure_count, open_until_ms = excluded.open_until_ms, probe_token = NULL`)
          .run(target.provider, target.model, failures, open ? now + cooldownMs : null)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private assertSameAttempt(decisionId: string, mode: string, attemptNumber: number, encoded: string): void {
    const row = this.db.prepare(`SELECT canonical_json FROM classification_attempts
      WHERE decision_id = ? AND execution_mode = ? AND attempt_number = ?`)
      .get(decisionId, mode, attemptNumber) as { canonical_json: string }
    if (row.canonical_json !== encoded) {
      throw new Error(`Conflicting classification attempt ${decisionId}/${mode}/${attemptNumber}`)
    }
  }

  private finishShadow(
    decisionId: string, token: string, status: 'pending' | 'completed' | 'failed',
    error: string | null, availableAtMs: number,
  ): void {
    const result = this.db.prepare(`UPDATE classification_shadow_outbox SET status = ?,
      available_at_ms = ?, lease_token = NULL, lease_expires_at_ms = NULL,
      last_error = ?, updated_at = ? WHERE decision_id = ? AND lease_token = ? AND status = 'leased'`)
      .run(status, availableAtMs, error, new Date(this.now()).toISOString(), decisionId, token)
    if (Number(result.changes) !== 1) throw new Error(`Lost classification shadow lease ${decisionId}`)
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Classification control plane is closed')
  }
}

/**
 * Dedicated live-path handoff. It never waits for SQLite's writer lock; a
 * contended enqueue fails immediately and is reported by ClassificationGateway.
 */
export class SqliteClassificationShadowWriter implements ClassificationShadowOutbox {
  private readonly db: Database
  private readonly now: () => number
  private readonly retention: ClassificationShadowRetentionPolicy
  private closed = false

  constructor(path: string, options: {
    now?: () => number
    retention?: Partial<ClassificationShadowRetentionPolicy>
  } = {}) {
    this.db = new DatabaseSync(resolve(path))
    this.now = options.now ?? Date.now
    this.retention = retentionPolicy(options.retention)
    this.db.exec('PRAGMA busy_timeout = 0; PRAGMA foreign_keys = ON;')
  }

  enqueue(value: ClassificationShadowEnvelope): void {
    if (this.closed) throw new Error('Classification shadow writer is closed')
    enqueueShadow(this.db, value, this.now(), this.retention)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }
}

function parseEnvelope(value: string): ClassificationShadowEnvelope {
  const parsed = JSON.parse(value) as ClassificationShadowEnvelope
  if (!parsed || typeof parsed !== 'object' || typeof parsed.decisionId !== 'string'
    || typeof parsed.workload !== 'string' || typeof parsed.decisionVersion !== 'string'
    || typeof parsed.stateDigest !== 'string' || typeof parsed.stableDecisionKey !== 'string') {
    throw new Error('Stored classification shadow envelope is invalid')
  }
  return parsed
}

function migrateClassificationAttempts(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(classification_attempts)').all() as Array<{ name?: unknown }>
  if (columns.some((column) => column.name === 'attempt_number')) return
  db.exec(`
    BEGIN IMMEDIATE;
    ALTER TABLE classification_attempts RENAME TO classification_attempts_v1;
    CREATE TABLE classification_attempts (
      decision_id TEXT NOT NULL,
      execution_mode TEXT NOT NULL CHECK (execution_mode IN ('authoritative', 'shadow')),
      attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
      workload TEXT NOT NULL,
      decision_version TEXT NOT NULL,
      status TEXT NOT NULL,
      canonical_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(decision_id, execution_mode, attempt_number)
    );
    INSERT INTO classification_attempts
      (decision_id, execution_mode, attempt_number, workload, decision_version, status, canonical_json, created_at)
    SELECT decision_id, execution_mode, 1, workload, decision_version, status,
      json_set(canonical_json, '$.schemaVersion', 'myboon.classification_attempt.v2', '$.attemptNumber', 1),
      created_at
    FROM classification_attempts_v1;
    DROP TABLE classification_attempts_v1;
    COMMIT;
  `)
}

function retentionPolicy(
  override: Partial<ClassificationShadowRetentionPolicy> | undefined,
): ClassificationShadowRetentionPolicy {
  const policy = { ...DEFAULT_CLASSIFICATION_SHADOW_RETENTION, ...override }
  if (!Number.isInteger(policy.terminalRetentionMs) || policy.terminalRetentionMs < 1
    || !Number.isInteger(policy.maxRows) || policy.maxRows < 1
    || !Number.isInteger(policy.maxBytes) || policy.maxBytes < 1) {
    throw new Error('Classification shadow retention policy must contain positive integers')
  }
  return policy
}

function enqueueShadow(
  db: Database,
  value: ClassificationShadowEnvelope,
  nowMs: number,
  retention: ClassificationShadowRetentionPolicy,
): void {
  const encoded = canonicalJson(value)
  const encodedBytes = Buffer.byteLength(encoded)
  db.exec('BEGIN IMMEDIATE')
  try {
    const existing = db.prepare('SELECT envelope_json FROM classification_shadow_outbox WHERE decision_id = ?')
      .get(value.decisionId) as { envelope_json: string } | undefined
    if (existing) {
      if (existing.envelope_json !== encoded) throw new Error(`Conflicting classification shadow envelope ${value.decisionId}`)
      db.exec('COMMIT')
      return
    }
    pruneShadowRows(db, nowMs, retention, 1, encodedBytes)
    const stats = shadowStats(db)
    if (stats.rows + 1 > retention.maxRows || stats.bytes + encodedBytes > retention.maxBytes) {
      throw new Error('Classification shadow outbox admission limit reached')
    }
    const nowIso = new Date(nowMs).toISOString()
    db.prepare(`INSERT INTO classification_shadow_outbox
      (decision_id, workload, decision_version, state_digest, envelope_json, status,
       available_at_ms, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`)
      .run(value.decisionId, value.workload, value.decisionVersion, value.stateDigest,
        encoded, nowMs, value.createdAt, nowIso)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function pruneShadowRows(
  db: Database,
  nowMs: number,
  retention: ClassificationShadowRetentionPolicy,
  incomingRows: number,
  incomingBytes: number,
): void {
  db.prepare(`DELETE FROM classification_shadow_outbox
    WHERE status IN ('completed', 'failed') AND updated_at < ?`)
    .run(new Date(nowMs - retention.terminalRetentionMs).toISOString())
  const stats = shadowStats(db)
  const rowsToReclaim = Math.max(0, stats.rows + incomingRows - retention.maxRows)
  const bytesToReclaim = Math.max(0, stats.bytes + incomingBytes - retention.maxBytes)
  if (rowsToReclaim === 0 && bytesToReclaim === 0) return
  db.prepare(`WITH ordered AS (
      SELECT decision_id,
        ROW_NUMBER() OVER (ORDER BY updated_at, decision_id) AS row_number,
        COALESCE(SUM(LENGTH(CAST(envelope_json AS BLOB))) OVER (
          ORDER BY updated_at, decision_id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
        ), 0) AS bytes_before
      FROM classification_shadow_outbox
      WHERE status IN ('completed', 'failed')
    )
    DELETE FROM classification_shadow_outbox WHERE decision_id IN (
      SELECT decision_id FROM ordered WHERE row_number <= ? OR bytes_before < ?
    )`).run(rowsToReclaim, bytesToReclaim)
}

function shadowStats(db: Database): ClassificationShadowOutboxStats {
  const row = db.prepare(`SELECT COUNT(*) AS rows,
      COALESCE(SUM(LENGTH(CAST(envelope_json AS BLOB))), 0) AS bytes,
      COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
      COALESCE(SUM(CASE WHEN status = 'leased' THEN 1 ELSE 0 END), 0) AS leased,
      COALESCE(SUM(CASE WHEN status IN ('completed', 'failed') THEN 1 ELSE 0 END), 0) AS terminal
    FROM classification_shadow_outbox`).get() as ClassificationShadowOutboxStats
  return {
    rows: Number(row.rows), bytes: Number(row.bytes), pending: Number(row.pending),
    leased: Number(row.leased), terminal: Number(row.terminal),
  }
}
