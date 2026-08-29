import assert from 'node:assert/strict'
import test from 'node:test'
import { formatDeepOrphanAudit, parseDeepOrphanAuditArgs } from './orphan-audit-command'

test('parser defaults to both source-local production databases and accepts one explicit scratch registry', () => {
  const defaults = parseDeepOrphanAuditArgs([], {})
  assert.deepEqual(defaults.registryPaths, ['.data/news.sqlite', '.data/pipeline.sqlite'])
  assert.equal(defaults.productionDefault, true)
  assert.deepEqual(defaults.configurationErrors, [
    'temp_roots_not_configured', 'profile_roots_not_configured', 'sandbox_executable_not_configured',
  ])
  const configured = parseDeepOrphanAuditArgs([], {
    NEWS_SQLITE_PATH: '/run/news.sqlite', PIPELINE_SQLITE_PATH: '/run/pipeline.sqlite',
    FEED_V3_DEEP_RESEARCH_AUDIT_TEMP_ROOTS: '/var/tmp/myboon-deep-workspaces',
    FEED_V3_DEEP_RESEARCH_AUDIT_PROFILE_ROOTS: '/var/tmp/myboon-deep-profiles',
    FEED_V3_DEEP_RESEARCH_WORKER_EXECUTABLE: '/opt/myboon/deep-worker',
    FEED_V3_DEEP_RESEARCH_AUDIT_LIMIT: '25',
  })
  assert.deepEqual(configured.registryPaths, ['/run/news.sqlite', '/run/pipeline.sqlite'])
  assert.equal(configured.limit, 25)
  assert.deepEqual(configured.configurationErrors, [])
  const scratch = parseDeepOrphanAuditArgs(['--registry', '/tmp/deep.sqlite'])
  assert.deepEqual(scratch.registryPaths, ['/tmp/deep.sqlite'])
  assert.equal(scratch.productionDefault, false)
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

test('formatter includes redacted unregistered discovery and explicit inspection gaps', () => {
  const report = formatDeepOrphanAudit({
    schemaVersion: 'myboon.deep_research_orphan_audit.v1',
    auditedAt: '2026-08-26T12:00:00.000Z', registeredExecutions: 0, entries: [],
  }, true, true, {
    auditedAt: '2026-08-26T12:00:00.000Z', activeExecutions: 0, suspectedOrphans: 1,
    unregisteredArtifacts: [{ kind: 'sandbox_executor', identifier: 'pid:42' }],
    incomplete: true, errors: ['profile_directory_inspection_failed'],
  }, {
    limit: 25, transientUnits: true, tempRootsConfigured: 1,
    profileRootsConfigured: 1, sandboxExecutablesConfigured: 1,
  })
  assert.equal(report.schemaVersion, 'myboon.deep_research_orphan_audit_report.v2')
  assert.equal(report.suspectedOrphans, 1)
  assert.equal(report.incomplete, true)
  assert.deepEqual(report.unregisteredArtifacts, [{ kind: 'sandbox_executor', identifier: 'pid:42' }])
  assert.doesNotMatch(JSON.stringify(report), /\/secret|argv|tempPath|profilePath/)
})
