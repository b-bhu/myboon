import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { legacyEntityOwnership, runLegacyEntityWhenOwned } from './legacy-ownership-guard'

test('PM2 injects one exact Entity ownership topology into both legacy runners and shared worker', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ecosystem = require('../../../../ecosystem.config.cjs') as { apps: Array<{ name: string, env: Record<string, string> }> }
  const names = [
    'myboon-news-entity-manager',
    'myboon-polymarket-entity-manager',
    'myboon-feed-v3-entity-manager',
  ]
  const keys = [
    'FEED_V3_ENTITY_MODE',
    'FEED_V3_ENTITY_ACTIVE_SOURCES',
    'FEED_V3_ENTITY_SHADOW_SOURCES',
    'FEED_V3_LEGACY_ENTITY_DISABLED_SOURCES',
    'FEED_V3_CUTOVER_RECEIPT_PATH',
    'FEED_V3_SHADOW_SAMPLE_BASIS_POINTS',
  ]
  const apps = names.map((name) => ecosystem.apps.find((app) => app.name === name))
  assert.equal(apps.every(Boolean), true)
  const topology = Object.fromEntries(keys.map((key) => [key, apps[0]!.env[key]]))
  for (const app of apps.slice(1)) {
    assert.deepEqual(Object.fromEntries(keys.map((key) => [key, app!.env[key]])), topology)
  }
  for (const key of keys) {
    if (process.env[key] === undefined) {
      assert.equal(Object.hasOwn(apps[0]!.env, key), false, `${key} must remain available to collectors/.env`)
    }
  }
})

test('reviewed source/stage receipt transfers one legacy Entity source to shared ownership', () => {
  const directory = mkdtempSync(join(tmpdir(), 'myboon-legacy-entity-cutover-'))
  try {
    const receiptPath = manifest(directory, 'news')
    const decision = legacyEntityOwnership('news', {
      FEED_V3_ENTITY_MODE: 'active',
      FEED_V3_ENTITY_ACTIVE_SOURCES: 'news',
      FEED_V3_LEGACY_ENTITY_DISABLED_SOURCES: 'news',
      FEED_V3_CUTOVER_RECEIPT_PATH: receiptPath,
    }, new Date('2026-08-27T00:00:00.000Z'))
    assert.deepEqual(decision, { sourceType: 'news', owner: 'shared' })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('shared ownership makes the common legacy runner boundary inert before dependency construction', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'myboon-legacy-entity-inert-'))
  let constructed = 0
  try {
    const result = await runLegacyEntityWhenOwned({
      sourceType: 'polymarket',
      env: {
        FEED_V3_ENTITY_MODE: 'active',
        FEED_V3_ENTITY_ACTIVE_SOURCES: 'polymarket',
        FEED_V3_LEGACY_ENTITY_DISABLED_SOURCES: 'polymarket',
        FEED_V3_CUTOVER_RECEIPT_PATH: manifest(directory, 'polymarket'),
      },
      now: new Date('2026-08-27T00:00:00.000Z'),
      run() { constructed += 1 },
    })
    assert.equal(result.ownership.owner, 'shared')
    assert.equal(constructed, 0)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('missing or wrong-source cutover evidence never falls back to a legacy claim', () => {
  const directory = mkdtempSync(join(tmpdir(), 'myboon-legacy-entity-cutover-'))
  try {
    const receiptPath = manifest(directory, 'polymarket')
    assert.throws(() => legacyEntityOwnership('news', {
      FEED_V3_ENTITY_MODE: 'active',
      FEED_V3_ENTITY_ACTIVE_SOURCES: 'news',
      FEED_V3_LEGACY_ENTITY_DISABLED_SOURCES: 'news',
      FEED_V3_CUTOVER_RECEIPT_PATH: receiptPath,
    }, new Date('2026-08-27T00:00:00.000Z')), /missing for entity:news/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('ordered rollback restores legacy ownership only after shared mode and disabled set are removed', () => {
  assert.throws(() => legacyEntityOwnership('polymarket', {
    FEED_V3_ENTITY_MODE: 'off',
    FEED_V3_LEGACY_ENTITY_DISABLED_SOURCES: 'polymarket',
  }), /disabled without active shared ownership/)
  assert.deepEqual(legacyEntityOwnership('polymarket', {
    FEED_V3_ENTITY_MODE: 'off',
    FEED_V3_ENTITY_ACTIVE_SOURCES: '',
    FEED_V3_LEGACY_ENTITY_DISABLED_SOURCES: '',
  }), { sourceType: 'polymarket', owner: 'legacy' })
})

function manifest(directory: string, sourceType: 'news' | 'polymarket'): string {
  const shadowName = `${sourceType}-shadow.json`
  const rollbackName = `${sourceType}-rollback.json`
  const shadow = JSON.stringify({
    schemaVersion: 'myboon.feed_v3_shadow_evaluation.v1', sourceType, stage: 'entity', passed: true, sampleSize: 1_000,
  })
  const rollback = JSON.stringify({
    schemaVersion: 'myboon.feed_v3_rollback_rehearsal.v1', sourceType, stage: 'entity', passed: true,
    rehearsedAt: '2026-08-26T00:00:00.000Z',
  })
  writeFileSync(join(directory, shadowName), shadow)
  writeFileSync(join(directory, rollbackName), rollback)
  const path = join(directory, 'manifest.json')
  writeFileSync(path, JSON.stringify({
    schemaVersion: 'myboon.feed_v3_cutover_manifest.v1',
    receipts: [{
      schemaVersion: 'myboon.feed_v3_cutover_receipt.v1',
      receiptId: `entity-${sourceType}`, sourceType, stage: 'entity',
      approvedAt: '2026-08-26T12:00:00.000Z', approvedBy: 'test', attestationMode: 'manual_review',
      expiresAt: '2099-01-01T00:00:00.000Z',
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
