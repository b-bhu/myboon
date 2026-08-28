import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import { parsePruneCommandArgs, runPruneCommand } from './prune-command'

test('prune CLI requires an exact directory and explicit retention/deletion limits', () => {
  assert.deepEqual(parsePruneCommandArgs([
    '--store', 'news', '--backup-dir', '/srv/myboon/backups', '--keep', '14', '--limit', '3',
  ]), {
    store: 'news', backupDir: resolve('/srv/myboon/backups'), keep: 14, limit: 3, apply: false,
  })
  assert.throws(() => parsePruneCommandArgs([]), /--store/)
  assert.throws(() => parsePruneCommandArgs([
    '--store', 'news', '--backup-dir', 'backups', '--keep', '7', '--limit', '2',
  ]), /absolute path/)
  assert.throws(() => parsePruneCommandArgs([
    '--store', 'news', '--backup-dir', '/tmp/backups', '--keep', '0', '--limit', '2',
  ]), /--keep/)
  assert.throws(() => parsePruneCommandArgs([
    '--store', 'news', '--backup-dir', '/tmp/backups', '--keep', '7',
  ]), /--limit is required/)
})

test('prune command is dry-run by default and selects only the requested store prefix', async () => {
  let called = false
  const input = parsePruneCommandArgs([
    '--store', 'pipeline', '--backup-dir', '/tmp/backups', '--keep', '7', '--limit', '2',
  ])
  const result = await runPruneCommand(input, async (options) => {
    called = true
    assert.ok(options)
    assert.equal(options.apply, false)
    assert.equal(options.prefix, 'pipeline-')
    return {
      mode: 'dry_run', backupDir: '/tmp/backups', prefix: 'pipeline-', keep: 7, limit: 2,
      matchedBackups: 0, retainedBackupPaths: [], candidateBackupPaths: [], candidateDeletePaths: [],
      deletedPaths: [], limited: false, auditedAt: '2026-08-27T00:00:00.000Z',
    }
  })
  assert.equal(called, true)
  assert.equal(result.mode, 'dry_run')
})
