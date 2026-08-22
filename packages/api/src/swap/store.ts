import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'

export type StoredSwapOutcome = 'confirmed' | 'failed' | 'unknown' | null

export interface SwapOrderRecord {
  requestId: string
  inputMint: string
  outputMint: string
  taker: string | null
  lastValidBlockHeight: string | null
  createdAt: string
}

export interface SwapExecutionRecord {
  requestId: string
  outcome: Exclude<StoredSwapOutcome, null>
  signature: string | null
  slot: string | null
  code: number | null
  message: string | null
  totalInputAmountAtomic: string | null
  totalOutputAmountAtomic: string | null
  inputAmountResultAtomic: string | null
  outputAmountResultAtomic: string | null
  updatedAt: string
}

export interface SwapExecutionStore {
  getOrder(requestId: string): SwapOrderRecord | null
  saveOrder(order: SwapOrderRecord): void
  getExecution(requestId: string): SwapExecutionRecord | null
  saveExecution(execution: SwapExecutionRecord): void
}

export function createMemorySwapExecutionStore(): SwapExecutionStore {
  const orders = new Map<string, SwapOrderRecord>()
  const executions = new Map<string, SwapExecutionRecord>()
  return {
    getOrder: (requestId) => orders.get(requestId) ?? null,
    saveOrder: (order) => orders.set(order.requestId, order),
    getExecution: (requestId) => executions.get(requestId) ?? null,
    saveExecution: (execution) => executions.set(execution.requestId, execution),
  }
}

interface SqliteStatement {
  get(...params: unknown[]): unknown
  run(...params: unknown[]): unknown
}

interface SqliteDatabase {
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
}

/**
 * Swap-owned durable metadata. Serialized transactions and wallet signatures
 * are intentionally never persisted. The store is an append/update boundary
 * for request lineage and terminal outcomes so an unknown submission survives
 * an API restart without making a second provider submission.
 */
export function createSqliteSwapExecutionStore(path = '.data/swap.sqlite'): SwapExecutionStore {
  const nodeRequire = createRequire(import.meta.url)
  const { DatabaseSync } = nodeRequire('node:sqlite') as {
    DatabaseSync: new (path: string) => SqliteDatabase
  }
  const dbPath = path === ':memory:' ? path : resolve(process.cwd(), path)
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA busy_timeout = 5000;')
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec(`
    CREATE TABLE IF NOT EXISTS swap_orders (
      request_id TEXT PRIMARY KEY,
      input_mint TEXT NOT NULL,
      output_mint TEXT NOT NULL,
      taker TEXT,
      last_valid_block_height TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS swap_executions (
      request_id TEXT PRIMARY KEY REFERENCES swap_orders(request_id),
      outcome TEXT NOT NULL CHECK (outcome IN ('confirmed', 'failed', 'unknown')),
      signature TEXT,
      slot TEXT,
      code INTEGER,
      message TEXT,
      total_input_amount_atomic TEXT,
      total_output_amount_atomic TEXT,
      input_amount_result_atomic TEXT,
      output_amount_result_atomic TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS swap_execution_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL REFERENCES swap_orders(request_id),
      outcome TEXT NOT NULL,
      signature TEXT,
      code INTEGER,
      message TEXT,
      recorded_at TEXT NOT NULL
    );
  `)

  const readOrder = db.prepare(`
    SELECT request_id, input_mint, output_mint, taker, last_valid_block_height, created_at
    FROM swap_orders WHERE request_id = ?
  `)
  const writeOrder = db.prepare(`
    INSERT INTO swap_orders(request_id, input_mint, output_mint, taker, last_valid_block_height, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(request_id) DO UPDATE SET
      input_mint = excluded.input_mint,
      output_mint = excluded.output_mint,
      taker = excluded.taker,
      last_valid_block_height = excluded.last_valid_block_height
  `)
  const readExecution = db.prepare(`
    SELECT request_id, outcome, signature, slot, code, message,
      total_input_amount_atomic, total_output_amount_atomic,
      input_amount_result_atomic, output_amount_result_atomic, updated_at
    FROM swap_executions WHERE request_id = ?
  `)
  const writeExecution = db.prepare(`
    INSERT INTO swap_executions(
      request_id, outcome, signature, slot, code, message,
      total_input_amount_atomic, total_output_amount_atomic,
      input_amount_result_atomic, output_amount_result_atomic, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(request_id) DO UPDATE SET
      outcome = excluded.outcome,
      signature = excluded.signature,
      slot = excluded.slot,
      code = excluded.code,
      message = excluded.message,
      total_input_amount_atomic = excluded.total_input_amount_atomic,
      total_output_amount_atomic = excluded.total_output_amount_atomic,
      input_amount_result_atomic = excluded.input_amount_result_atomic,
      output_amount_result_atomic = excluded.output_amount_result_atomic,
      updated_at = excluded.updated_at
  `)
  const writeEvent = db.prepare(`
    INSERT INTO swap_execution_events(request_id, outcome, signature, code, message, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `)

  return {
    getOrder(requestId) {
      const row = readOrder.get(requestId) as Record<string, unknown> | undefined
      if (!row) return null
      return {
        requestId: String(row.request_id),
        inputMint: String(row.input_mint),
        outputMint: String(row.output_mint),
        taker: row.taker === null || row.taker === undefined ? null : String(row.taker),
        lastValidBlockHeight: row.last_valid_block_height === null || row.last_valid_block_height === undefined
          ? null
          : String(row.last_valid_block_height),
        createdAt: String(row.created_at),
      }
    },
    saveOrder(order) {
      writeOrder.run(
        order.requestId,
        order.inputMint,
        order.outputMint,
        order.taker,
        order.lastValidBlockHeight,
        order.createdAt,
      )
    },
    getExecution(requestId) {
      const row = readExecution.get(requestId) as Record<string, unknown> | undefined
      if (!row) return null
      return {
        requestId: String(row.request_id),
        outcome: String(row.outcome) as Exclude<StoredSwapOutcome, null>,
        signature: row.signature === null || row.signature === undefined ? null : String(row.signature),
        slot: row.slot === null || row.slot === undefined ? null : String(row.slot),
        code: typeof row.code === 'number' ? row.code : null,
        message: row.message === null || row.message === undefined ? null : String(row.message),
        totalInputAmountAtomic: row.total_input_amount_atomic === null || row.total_input_amount_atomic === undefined
          ? null : String(row.total_input_amount_atomic),
        totalOutputAmountAtomic: row.total_output_amount_atomic === null || row.total_output_amount_atomic === undefined
          ? null : String(row.total_output_amount_atomic),
        inputAmountResultAtomic: row.input_amount_result_atomic === null || row.input_amount_result_atomic === undefined
          ? null : String(row.input_amount_result_atomic),
        outputAmountResultAtomic: row.output_amount_result_atomic === null || row.output_amount_result_atomic === undefined
          ? null : String(row.output_amount_result_atomic),
        updatedAt: String(row.updated_at),
      }
    },
    saveExecution(execution) {
      writeEvent.run(
        execution.requestId,
        execution.outcome,
        execution.signature,
        execution.code,
        execution.message,
        execution.updatedAt,
      )
      writeExecution.run(
        execution.requestId,
        execution.outcome,
        execution.signature,
        execution.slot,
        execution.code,
        execution.message,
        execution.totalInputAmountAtomic,
        execution.totalOutputAmountAtomic,
        execution.inputAmountResultAtomic,
        execution.outputAmountResultAtomic,
        execution.updatedAt,
      )
    },
  }
}
