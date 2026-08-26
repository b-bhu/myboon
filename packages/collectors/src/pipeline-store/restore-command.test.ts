import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { parseRestoreCommandArgs, runRestoreCommand } from './restore-command'

test('restore CLI is dry-run by default and requires explicit store/backup/target', () => {
  assert.deepEqual(parseRestoreCommandArgs([
    '--store', 'news', '--backup', '/tmp/news-backup.sqlite', '--target', '/tmp/news-restored.sqlite',
  ]), {
    store: 'news', backupPath: '/tmp/news-backup.sqlite', targetPath: '/tmp/news-restored.sqlite',
    apply: false, force: false,
  })
  assert.throws(() => parseRestoreCommandArgs([]), /--store is required/)
  assert.throws(() => parseRestoreCommandArgs(['--store', 'other']), /pipeline or news/)
  assert.throws(() => parseRestoreCommandArgs([
    '--store', 'news', '--backup', '/tmp/a', '--target', '/tmp/b', '--force',
  ]), /only with --apply/)
})

test('dry-run verifies only and never calls restore', async () => {
  let verifies = 0
  let restores = 0
  const result = await runRestoreCommand({
    store: 'pipeline', backupPath: '/tmp/pipeline-backup.sqlite', targetPath: '/tmp/restored.sqlite',
    apply: false, force: false,
  }, {
    verifyPipeline: async () => {
      verifies += 1
      return { ok: true, integrity: 'ok', tableCounts: { pipeline_candidates: 3 }, mismatches: [] }
    },
    restorePipeline: async () => {
      restores += 1
      throw new Error('must not restore in dry-run')
    },
  })
  assert.equal(verifies, 1)
  assert.equal(restores, 0)
  assert.equal(result.mode, 'dry_run')
  assert.equal(result.backupPath, resolve('/tmp/pipeline-backup.sqlite'))
})

test('apply dispatches only the selected store restore and forwards force', async () => {
  let newsCalls = 0
  let pipelineCalls = 0
  const result = await runRestoreCommand({
    store: 'news', backupPath: '/tmp/news-backup.sqlite', targetPath: '/tmp/news-restored.sqlite',
    apply: true, force: true,
  }, {
    restoreNews: async (input) => {
      newsCalls += 1
      assert.equal(input.force, true)
      return { targetPath: resolve(input.targetPath), tableCounts: { news_candidate_observations: 2 }, verified: true }
    },
    restorePipeline: async () => {
      pipelineCalls += 1
      throw new Error('wrong store')
    },
  })
  assert.equal(newsCalls, 1)
  assert.equal(pipelineCalls, 0)
  assert.equal(result.mode, 'apply')
})

test('restore refuses the backup path as its target before any I/O', async () => {
  await assert.rejects(() => runRestoreCommand({
    store: 'pipeline', backupPath: '/tmp/same.sqlite', targetPath: '/tmp/same.sqlite',
    apply: true, force: true,
  }), /must be different/)
})
