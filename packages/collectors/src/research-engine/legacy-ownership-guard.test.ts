import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { newsResearchRunnerOwnership } from '../news/run-news'
import { polymarketResearchRunnerOwnership } from '../polymarket/run-researcher'
import { legacyResearchOwnership, runLegacyResearchWhenOwned } from './legacy-ownership-guard'

test('PM2 gives both legacy researchers and the shared worker one Research ownership topology', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ecosystem = require('../../../../ecosystem.config.cjs') as { apps: Array<{ name: string, env: Record<string, string> }> }
  const names = ['myboon-news-researcher', 'myboon-polymarket-researcher', 'myboon-feed-v3-research']
  const keys = [
    'FEED_V3_RESEARCH_MODE', 'FEED_V3_RESEARCH_ACTIVE_SOURCES',
    'FEED_V3_RESEARCH_SHADOW_SOURCES', 'FEED_V3_LEGACY_RESEARCH_DISABLED_SOURCES',
    'FEED_V3_CUTOVER_RECEIPT_PATH', 'FEED_V3_SHADOW_SAMPLE_BASIS_POINTS',
  ]
  const apps = names.map((name) => ecosystem.apps.find((app) => app.name === name))
  assert.equal(apps.every(Boolean), true)
  const topology = Object.fromEntries(keys.map((key) => [key, apps[0]!.env[key]]))
  for (const app of apps.slice(1)) {
    assert.deepEqual(Object.fromEntries(keys.map((key) => [key, app!.env[key]])), topology)
  }
  for (const key of keys) {
    if (process.env[key] === undefined) assert.equal(Object.hasOwn(apps[0]!.env, key), false)
  }
})

test('receipt-bound shared Research ownership makes the legacy boundary inert before construction', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'myboon-legacy-research-'))
  let constructed = 0
  try {
    const result = await runLegacyResearchWhenOwned({
      sourceType: 'news',
      env: activeEnv('news', manifest(directory, 'news')),
      now: new Date('2026-08-27T00:00:00.000Z'),
      run() { constructed += 1 },
    })
    assert.equal(result.ownership.owner, 'shared')
    assert.equal(constructed, 0)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('missing source receipt or incomplete transfer fails closed instead of claiming', () => {
  const directory = mkdtempSync(join(tmpdir(), 'myboon-legacy-research-'))
  try {
    assert.throws(() => legacyResearchOwnership(
      'news', activeEnv('news', manifest(directory, 'polymarket')),
      new Date('2026-08-27T00:00:00.000Z'),
    ), /missing for research:news/)
    assert.throws(() => legacyResearchOwnership('news', {
      FEED_V3_RESEARCH_MODE: 'off', FEED_V3_LEGACY_RESEARCH_DISABLED_SOURCES: 'news',
    }), /disabled without active shared ownership/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('ordered rollback restores legacy Research only after shared ownership is removed', () => {
  const env = {
    FEED_V3_RESEARCH_MODE: 'off', FEED_V3_RESEARCH_ACTIVE_SOURCES: '',
    FEED_V3_LEGACY_RESEARCH_DISABLED_SOURCES: '',
  }
  assert.deepEqual(legacyResearchOwnership('polymarket', env), { sourceType: 'polymarket', owner: 'legacy' })
  assert.deepEqual(newsResearchRunnerOwnership(env), { sourceType: 'news', owner: 'legacy' })
  assert.deepEqual(polymarketResearchRunnerOwnership(env), { sourceType: 'polymarket', owner: 'legacy' })
})

function activeEnv(sourceType: 'news' | 'polymarket', receiptPath: string) {
  return {
    FEED_V3_RESEARCH_MODE: 'active', FEED_V3_RESEARCH_ACTIVE_SOURCES: sourceType,
    FEED_V3_LEGACY_RESEARCH_DISABLED_SOURCES: sourceType,
    FEED_V3_CUTOVER_RECEIPT_PATH: receiptPath,
  }
}

function manifest(directory: string, sourceType: 'news' | 'polymarket'): string {
  const shadowName = `${sourceType}-shadow.json`
  const rollbackName = `${sourceType}-rollback.json`
  const shadow = JSON.stringify({
    schemaVersion: 'myboon.feed_v3_shadow_evaluation.v1', sourceType, stage: 'research',
    passed: true, sampleSize: 1_000,
  })
  const rollback = JSON.stringify({
    schemaVersion: 'myboon.feed_v3_rollback_rehearsal.v1', sourceType, stage: 'research',
    passed: true, rehearsedAt: '2026-08-26T00:00:00.000Z',
  })
  writeFileSync(join(directory, shadowName), shadow)
  writeFileSync(join(directory, rollbackName), rollback)
  const path = join(directory, 'manifest.json')
  writeFileSync(path, JSON.stringify({
    schemaVersion: 'myboon.feed_v3_cutover_manifest.v1', receipts: [{
      schemaVersion: 'myboon.feed_v3_cutover_receipt.v1', receiptId: `research-${sourceType}`,
      sourceType, stage: 'research', approvedAt: '2026-08-26T12:00:00.000Z', approvedBy: 'test',
      attestationMode: 'manual_review', expiresAt: '2099-01-01T00:00:00.000Z',
      shadowEvaluation: {
        sampleSize: 1_000, passed: true, artifactPath: shadowName,
        artifactSchemaVersion: 'myboon.feed_v3_shadow_evaluation.v1',
        artifactSha256: createHash('sha256').update(shadow).digest('hex'),
      },
      rollbackRehearsal: {
        rehearsedAt: '2026-08-26T00:00:00.000Z', passed: true, artifactPath: rollbackName,
        artifactSchemaVersion: 'myboon.feed_v3_rollback_rehearsal.v1',
        artifactSha256: createHash('sha256').update(rollback).digest('hex'),
      },
    }],
  }))
  return path
}
