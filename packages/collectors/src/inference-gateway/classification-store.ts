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

/**
 * One crash-safe SQLite control plane shared by every PM2 process on the VPS.
 * It owns capacity leases, provider circuit/rate state, immutable audit rows,
 * and the best-effort shadow outbox.
 */
export class SqliteClassificationControlPlane implements
ClassificationCapacityCoordinator, ClassificationAuditSink, ClassificationShadowOutbox {
  private readonly db: Database
  private readonly now: () => number
  private closed = false

  constructor(path: string, options: { now?: () => number } = {}) {
    const resolved = resolve(path)
    mkdirSync(dirname(resolved), { recursive: true })
    this.db = new DatabaseSync(resolved)
    this.now = options.now ?? Date.now
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
        workload TEXT NOT NULL,
        decision_version TEXT NOT NULL,
        status TEXT NOT NULL,
        canonical_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(decision_id, execution_mode)
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
      const recent = this.db.prepare(`
        SELECT COUNT(*) AS count, MIN(occurred_at_ms) AS oldest
        FROM classification_rate_events WHERE provider = ? AND model = ?
          AND lane = ? AND occurred_at_ms > ?
      `).get(target.provider, target.model, mode, now - policy.windowMs) as { count: number; oldest: number | null }
      if (recent.count >= policy.maxCalls) {
        throw new InferenceGatewayError('Classification rate limit reached', {
          category: 'provider_rate_limited', retryable: true,
          retryAfterMs: Math.max(1, policy.windowMs - (now - (recent.oldest ?? now))),
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
      (decision_id, execution_mode, workload, decision_version, status, canonical_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(record.decisionId, record.executionMode, record.workload, record.decisionVersion,
        record.status, encoded, record.finishedAt)
    if (Number(result.changes) === 0) this.assertSameAttempt(record.decisionId, record.executionMode, encoded)
  }

  getAttempt(decisionId: string, executionMode: 'authoritative' | 'shadow'): ClassificationAttemptRecord | null {
    this.assertOpen()
    const row = this.db.prepare(`SELECT canonical_json FROM classification_attempts
      WHERE decision_id = ? AND execution_mode = ?`).get(decisionId, executionMode) as {
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
    const encoded = canonicalJson(value)
    const nowMs = this.now()
    const result = this.db.prepare(`INSERT OR IGNORE INTO classification_shadow_outbox
      (decision_id, workload, decision_version, state_digest, envelope_json, status,
       available_at_ms, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`)
      .run(value.decisionId, value.workload, value.decisionVersion, value.stateDigest,
        encoded, nowMs, value.createdAt, value.createdAt)
    if (Number(result.changes) === 0) {
      const row = this.db.prepare('SELECT envelope_json FROM classification_shadow_outbox WHERE decision_id = ?')
        .get(value.decisionId) as { envelope_json: string }
      if (row.envelope_json !== encoded) throw new Error(`Conflicting classification shadow envelope ${value.decisionId}`)
    }
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
  }

  failShadow(decisionId: string, leaseToken: string, error: string, retryAtMs: number | null): void {
    this.finishShadow(decisionId, leaseToken, retryAtMs === null ? 'failed' : 'pending', error.slice(0, 1_000), retryAtMs ?? this.now())
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

  private assertSameAttempt(decisionId: string, mode: string, encoded: string): void {
    const row = this.db.prepare(`SELECT canonical_json FROM classification_attempts
      WHERE decision_id = ? AND execution_mode = ?`).get(decisionId, mode) as { canonical_json: string }
    if (row.canonical_json !== encoded) throw new Error(`Conflicting classification attempt ${decisionId}/${mode}`)
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

function parseEnvelope(value: string): ClassificationShadowEnvelope {
  const parsed = JSON.parse(value) as ClassificationShadowEnvelope
  if (!parsed || typeof parsed !== 'object' || typeof parsed.decisionId !== 'string'
    || typeof parsed.workload !== 'string' || typeof parsed.decisionVersion !== 'string'
    || typeof parsed.stateDigest !== 'string' || typeof parsed.stableDecisionKey !== 'string') {
    throw new Error('Stored classification shadow envelope is invalid')
  }
  return parsed
}
