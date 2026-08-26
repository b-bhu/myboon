import assert from 'node:assert/strict'
import test from 'node:test'
import { formatDeepOrphanAudit, parseDeepOrphanAuditArgs } from './orphan-audit-command'

test('parser defaults to both source-local production databases and accepts one explicit scratch registry', () => {
  assert.deepEqual(parseDeepOrphanAuditArgs([], {}), {
    registryPaths: ['.data/news.sqlite', '.data/pipeline.sqlite'], registryRequired: true, productionDefault: true,
  })
  assert.deepEqual(parseDeepOrphanAuditArgs([], { NEWS_SQLITE_PATH: '/run/news.sqlite', PIPELINE_SQLITE_PATH: '/run/pipeline.sqlite' }), {
    registryPaths: ['/run/news.sqlite', '/run/pipeline.sqlite'], registryRequired: true, productionDefault: true,
  })
  assert.deepEqual(parseDeepOrphanAuditArgs(['--registry', '/tmp/deep.sqlite']), {
    registryPaths: ['/tmp/deep.sqlite'], registryRequired: true, productionDefault: false,
  })
  assert.throws(() => parseDeepOrphanAuditArgs(['--apply']), /Usage/)
})

test('formatter identifies only expired live artifacts and redacts trace and filesystem paths', () => {
  const report = formatDeepOrphanAudit({
    schemaVersion: 'myboon.deep_research_orphan_audit.v1', auditedAt: '2026-08-26T12:00:00.000Z',
    registeredExecutions: 2,
    entries: [
      {
        metadata: {
          unitName: 'myboon-deep-old.service', jobId: 'job-old', workId: 'work-old', traceId: 'secret-trace', sourceType: 'news',
          startedAt: '2026-08-26T10:00:00.000Z', deadlineAt: '2026-08-26T10:10:00.000Z',
          tempPath: '/secret/temp', profilePath: '/secret/profile',
        },
        unitActive: true, tempPathPresent: true, deadlineExpired: true, auditError: null,
      },
      {
        metadata: {
          unitName: 'myboon-deep-current.service', jobId: 'job-current', workId: 'work-current', traceId: 'trace', sourceType: 'news',
          startedAt: '2026-08-26T11:59:00.000Z', deadlineAt: '2026-08-26T12:09:00.000Z',
          tempPath: '/tmp/current', profilePath: '/tmp/profile',
        },
        unitActive: true, tempPathPresent: true, deadlineExpired: false, auditError: null,
      },
    ],
  })
  assert.equal(report.suspectedOrphans, 1)
  assert.equal(report.entries[0]?.suspectedOrphan, true)
  assert.equal(report.entries[1]?.suspectedOrphan, false)
  assert.equal(JSON.stringify(report).includes('secret-trace'), false)
  assert.equal(JSON.stringify(report).includes('/secret/'), false)
})

test('missing configured source-local production database is an incomplete audit', () => {
  const report = formatDeepOrphanAudit({
    schemaVersion: 'myboon.deep_research_orphan_audit.v1',
    auditedAt: '2026-08-26T12:00:00.000Z', registeredExecutions: 0, entries: [],
  }, false, true)
  assert.equal(report.registryPresent, false)
  assert.equal(report.registryRequired, true)
  assert.equal(report.incompleteAudits, 1)
})
