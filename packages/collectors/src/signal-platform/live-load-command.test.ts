import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parseLiveLoadArgs, runLiveLoadCommand } from './live-load-command'

const HASH = 'a'.repeat(64)

test('live-load CLI is a dry-run plan by default and never calls the collector', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feed-v3-live-load-plan-'))
  try {
    const policyPath = join(dir, 'policy.json')
    writeFileSync(policyPath, JSON.stringify(liveLoadPolicy()))
    const command = parseLiveLoadArgs([
      '--policy', policyPath, '--output', join(dir, 'evidence.json'), '--artifact-dir', dir,
      '--source-types', 'news,polymarket', '--duration-seconds', '300', '--baseline-arrivals-per-second', '2',
    ])
    let calls = 0
    const result = await runLiveLoadCommand({ command, collector: { collect: async () => { calls += 1; return {} } } })
    assert.equal(command.execute, false)
    assert.equal(command.plan.executesProviders, false)
    assert.equal(result.wroteOutput, false)
    assert.equal(calls, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('checked-in live-load CLI execution fails closed without an injected collector', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feed-v3-live-load-closed-'))
  try {
    const policyPath = join(dir, 'policy.json')
    writeFileSync(policyPath, JSON.stringify(liveLoadPolicy()))
    const command = parseLiveLoadArgs([
      '--policy', policyPath, '--output', join(dir, 'evidence.json'), '--artifact-dir', dir,
      '--source-types', 'news', '--execute',
    ])
    await assert.rejects(runLiveLoadCommand({ command }), /collector implementation/)
    assert.throws(() => parseLiveLoadArgs([
      '--policy', policyPath, '--output', join(dir, 'evidence.json'), '--artifact-dir', dir,
      '--source-types', 'news', '--provider-key', 'secret',
    ]), /Unknown argument/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

function liveLoadPolicy() {
  return {
    schemaVersion: 'myboon.feed_v3_operational_evidence_policy.v1', policyId: 'live-load.policy.v1',
    evidenceKind: 'live-load', attestationMode: 'manual_review', reviewedAt: '2026-08-24T00:00:00.000Z', reviewedBySha256: HASH,
    expiresAt: '2026-09-30T00:00:00.000Z', thresholds: {
      minimumDurationMs: 300_000, minimumArrivalMultiplier: 2, minimumCompletionRatio: 0.99,
      maximumQueueP95Ms: 1_000, maximumQueueDepth: 25, maximumTerminalFailures: 0,
      maximumDuplicateArtifacts: 0, maximumSqliteWriteErrors: 0,
    },
  }
}
