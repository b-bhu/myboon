import type { SupabaseClient } from '@supabase/supabase-js'
import type { PipelineStore } from './pipeline-store/store'

export type PipelineRunStatus = 'running' | 'succeeded' | 'failed' | 'skipped' | 'partial'

export interface PipelineRunStartInput {
  source: string
  sourceArea?: string | null
  stage: string
  inputRef?: string | null
  startedAt?: string
  metadata?: Record<string, unknown>
}

export interface PipelineRunFinishInput {
  status: Exclude<PipelineRunStatus, 'running'>
  outputRef?: string | null
  finishedAt?: string
  counts?: Record<string, number | boolean>
  error?: string | null
  metadata?: Record<string, unknown>
}

export interface PipelineRunRecord {
  id: string
}

export interface PipelineLedgerStore {
  startRun(input: PipelineRunStartInput): Promise<PipelineRunRecord>
  finishRun(id: string, input: PipelineRunFinishInput): Promise<void>
}

export class SupabasePipelineLedgerStore implements PipelineLedgerStore {
  constructor(private readonly db: SupabaseClient) {}

  async startRun(input: PipelineRunStartInput): Promise<PipelineRunRecord> {
    const startedAt = input.startedAt ?? new Date().toISOString()
    const { data, error } = await this.db
      .from('pipeline_runs')
      .insert({
        source: input.source,
        source_area: input.sourceArea ?? null,
        stage: input.stage,
        status: 'running',
        input_ref: input.inputRef ?? null,
        started_at: startedAt,
        metadata: input.metadata ?? {},
        updated_at: startedAt,
      })
      .select('id')
      .single()

    if (error) throw new Error(`pipeline run start failed: ${error.message}`)
    return { id: String((data as { id: unknown }).id) }
  }

  async finishRun(id: string, input: PipelineRunFinishInput): Promise<void> {
    const finishedAt = input.finishedAt ?? new Date().toISOString()
    const payload: Record<string, unknown> = {
      status: input.status,
      output_ref: input.outputRef ?? null,
      finished_at: finishedAt,
      counts: input.counts ?? {},
      error: input.error ? boundError(input.error) : null,
      updated_at: finishedAt,
    }
    if (input.metadata !== undefined) {
      payload.metadata = input.metadata
    }

    const { error } = await this.db
      .from('pipeline_runs')
      .update(payload)
      .eq('id', id)

    if (error) throw new Error(`pipeline run finish failed: ${error.message}`)
  }
}

/**
 * Adapts any PipelineStore (e.g. SqlitePipelineStore) to PipelineLedgerStore.
 *
 * PipelineStore's startRun/finishRun (P1/P2) require startedAt/finishedAt as
 * real strings with no default - the SQLite implementation has no
 * server-side "now" to fall back on the way a Postgres DEFAULT would.
 * PipelineLedgerStore, by contrast, treats both as optional and expects the
 * store to default them, matching how SupabasePipelineLedgerStore behaved.
 * This adapter defaults them the same way (`?? new Date().toISOString()`)
 * before delegating to the underlying store, so callers that construct a
 * PipelineStore-backed ledger can drop in withPipelineRun exactly like the
 * Supabase-backed one, without needing to remember to pass startedAt/
 * finishedAt themselves.
 */
export class PipelineStoreLedgerStore implements PipelineLedgerStore {
  constructor(private readonly store: PipelineStore) {}

  async startRun(input: PipelineRunStartInput): Promise<PipelineRunRecord> {
    return this.store.startRun({ ...input, startedAt: input.startedAt ?? new Date().toISOString() })
  }

  async finishRun(id: string, input: PipelineRunFinishInput): Promise<void> {
    await this.store.finishRun(id, { ...input, finishedAt: input.finishedAt ?? new Date().toISOString() })
  }
}

export function compactCounts(result: unknown): Record<string, number | boolean> {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return {}
  const counts: Record<string, number | boolean> = {}
  for (const [key, value] of Object.entries(result)) {
    if (typeof value === 'number' || typeof value === 'boolean') {
      counts[key] = value
    }
  }
  return counts
}

export function boundError(error: unknown, maxLength = 2000): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`
}

export async function withPipelineRun<T>(
  store: PipelineLedgerStore,
  input: PipelineRunStartInput,
  run: () => Promise<T>,
  countsForResult: (result: T) => Record<string, number | boolean> = compactCounts
): Promise<T> {
  const started = await store.startRun(input)
  try {
    const result = await run()
    await store.finishRun(started.id, {
      status: 'succeeded',
      counts: countsForResult(result),
    })
    return result
  } catch (error) {
    await store.finishRun(started.id, {
      status: 'failed',
      error: boundError(error),
    })
    throw error
  }
}
