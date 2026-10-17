import assert from 'node:assert/strict'
import test from 'node:test'
import {
  boundError,
  compactCounts,
  type ErrorLogEntry,
  type PipelineLedgerStore,
  type PipelineRunFinishInput,
  type PipelineRunStartInput,
  resetLedgerFailureCounts,
  withPipelineRun,
} from './pipeline-ledger'

class InMemoryLedgerStore implements PipelineLedgerStore {
  starts: PipelineRunStartInput[] = []
  finishes: Array<{ id: string } & PipelineRunFinishInput> = []
  startError: unknown = null
  finishError: unknown = null

  async startRun(input: PipelineRunStartInput) {
    this.starts.push(input)
    if (this.startError !== null) throw this.startError
    return { id: `run-${this.starts.length}` }
  }

  async finishRun(id: string, input: PipelineRunFinishInput): Promise<void> {
    if (this.finishError !== null) throw this.finishError
    this.finishes.push({ id, ...input })
  }
}

function capturingLogError(): { entries: ErrorLogEntry[], logError: (entry: ErrorLogEntry) => void } {
  const entries: ErrorLogEntry[] = []
  return { entries, logError: (entry) => { entries.push(entry) } }
}

test('compactCounts keeps only top-level numeric and boolean fields', () => {
  assert.deepEqual(compactCounts({
    fetched: 10,
    dryRun: false,
    observedAt: '2026-07-06T00:00:00.000Z',
    rows: [{ id: 'row-1' }],
    nested: { count: 1 },
  }), {
    fetched: 10,
    dryRun: false,
  })
})

test('withPipelineRun writes running and succeeded ledger rows with compact counts', async () => {
  const store = new InMemoryLedgerStore()
  const result = await withPipelineRun(
    store,
    { source: 'polymarket', sourceArea: 'markets', stage: 'polymarket.researcher' },
    async () => ({ pendingFetched: 4, researchRowsWritten: 2, rows: [{ id: 'heavy-row' }] })
  )

  assert.equal(result.researchRowsWritten, 2)
  assert.deepEqual(store.starts, [{
    source: 'polymarket',
    sourceArea: 'markets',
    stage: 'polymarket.researcher',
  }])
  assert.deepEqual(store.finishes, [{
    id: 'run-1',
    status: 'succeeded',
    counts: {
      pendingFetched: 4,
      researchRowsWritten: 2,
    },
  }])
})

test('withPipelineRun writes failed ledger row and rethrows', async () => {
  const store = new InMemoryLedgerStore()
  await assert.rejects(
    withPipelineRun(
      store,
      { source: 'feed', stage: 'publisher' },
      async () => {
        throw new Error('publisher exploded')
      }
    ),
    /publisher exploded/
  )

  assert.deepEqual(store.finishes, [{
    id: 'run-1',
    status: 'failed',
    error: 'publisher exploded',
  }])
})

test('boundError clips long messages', () => {
  const error = boundError(`x${'a'.repeat(20)}`, 10)
  assert.equal(error, 'xaaaaaa...')
})

test('withPipelineRun runs the tick without a record when startRun fails', async () => {
  resetLedgerFailureCounts()
  const store = new InMemoryLedgerStore()
  store.startError = new Error('supabase unreachable')
  const { entries, logError } = capturingLogError()

  const result = await withPipelineRun(
    store,
    { source: 'feed', stage: 'publisher' },
    async () => ({ processed: 3 }),
    compactCounts,
    { logError }
  )

  assert.deepEqual(result, { processed: 3 })
  assert.deepEqual(store.finishes, [])
  assert.equal(entries.length, 1)
  assert.equal(entries[0].kind, 'ledger_start_failed')
  assert.equal(entries[0].app, 'publisher')
  assert.equal(entries[0].count, 1)
})

test('withPipelineRun counts consecutive start failures per app and resets on success', async () => {
  resetLedgerFailureCounts()
  const failing = new InMemoryLedgerStore()
  failing.startError = new Error('supabase unreachable')
  const { entries, logError } = capturingLogError()

  await withPipelineRun(failing, { source: 'feed', stage: 'publisher' }, async () => 'first', compactCounts, { logError })
  await withPipelineRun(failing, { source: 'feed', stage: 'publisher' }, async () => 'second', compactCounts, { logError })
  assert.deepEqual(
    entries.filter((entry) => entry.kind === 'ledger_start_failed').map((entry) => entry.count),
    [1, 2]
  )

  const succeeding = new InMemoryLedgerStore()
  await withPipelineRun(succeeding, { source: 'feed', stage: 'publisher' }, async () => 'third', compactCounts, { logError })
  await withPipelineRun(failing, { source: 'feed', stage: 'publisher' }, async () => 'fourth', compactCounts, { logError })
  assert.deepEqual(
    entries.filter((entry) => entry.kind === 'ledger_start_failed').map((entry) => entry.count),
    [1, 2, 1]
  )
})

test('withPipelineRun returns the result and logs when finishRun fails', async () => {
  resetLedgerFailureCounts()
  const store = new InMemoryLedgerStore()
  store.finishError = new Error('ledger write failed')
  const { entries, logError } = capturingLogError()

  const result = await withPipelineRun(
    store,
    { source: 'feed', stage: 'publisher' },
    async () => ({ processed: 5 }),
    compactCounts,
    { logError }
  )

  assert.deepEqual(result, { processed: 5 })
  assert.equal(entries.length, 1)
  assert.equal(entries[0].kind, 'ledger_finish_failed')
  assert.equal(entries[0].app, 'publisher')
})

test('withPipelineRun rethrows the run error when finishRun also fails', async () => {
  resetLedgerFailureCounts()
  const store = new InMemoryLedgerStore()
  store.finishError = new Error('ledger write failed')
  const { entries, logError } = capturingLogError()

  await assert.rejects(
    withPipelineRun(
      store,
      { source: 'feed', stage: 'publisher' },
      async () => {
        throw new Error('publisher exploded')
      },
      compactCounts,
      { logError }
    ),
    /publisher exploded/
  )

  assert.deepEqual(entries.map((entry) => entry.kind), ['ledger_finish_failed'])
})

test('withPipelineRun rethrows the run error when startRun failed first', async () => {
  resetLedgerFailureCounts()
  const store = new InMemoryLedgerStore()
  store.startError = new Error('supabase unreachable')
  const { entries, logError } = capturingLogError()

  await assert.rejects(
    withPipelineRun(
      store,
      { source: 'feed', stage: 'publisher' },
      async () => {
        throw new Error('publisher exploded')
      },
      compactCounts,
      { logError }
    ),
    /publisher exploded/
  )

  assert.deepEqual(store.finishes, [])
  assert.deepEqual(entries.map((entry) => entry.kind), ['ledger_start_failed'])
})
