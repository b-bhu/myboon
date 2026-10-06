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

/**
 * One crash-safe SQLite control plane shared by every PM2 process on the VPS.
 * It owns capacity leases, provider circuit/rate state, immutable audit rows,
 * and policy-outcome records.
 */
export class SqliteClassificationControlPlane implements
ClassificationCapacityCoordinator, ClassificationAuditSink {
  private readonly db: Database
  private readonly now: () => number
  private closed = false

  constructor(path: string, options: {
    now?: () => number
  } = {}) {
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
      const concurrencyLimit = policy.liveConcurrency
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

  private assertOpen(): void {
    if (this.closed) throw new Error('Classification control plane is closed')
  }
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
