import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { RetiredLaneSqlitePathError } from '../lane-store/paths'
import { SqlitePipelineStore } from './sqlite-store'
import { runPipelineStoreContract } from './store-contract'

runPipelineStoreContract('sqlite', () => new SqlitePipelineStore(':memory:'))

test('a configured pipeline.sqlite path is rejected loudly (issue #369)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'retired-pipeline-path-'))
  try {
    const env = { PIPELINE_SQLITE_PATH: join(dir, 'pipeline.sqlite') }
    assert.throws(
      () => new SqlitePipelineStore(env.PIPELINE_SQLITE_PATH),
      (error: unknown) => {
        assert.ok(error instanceof RetiredLaneSqlitePathError)
        assert.match(error.message, /polymarket/)
        assert.match(error.message, /pipeline\.sqlite/)
        assert.match(error.message, /polymarket-lane\.sqlite/)
        assert.match(error.message, /see #369/)
        return true
      },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})