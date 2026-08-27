import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  parseDeepContainmentVerificationArgs,
  runDeepContainmentVerification,
  type DeepContainmentVerificationArtifact,
} from './containment-verification'

test('containment verifier refuses dry-run, implicit fixture, and relative output targets', () => {
  assert.throws(() => parseDeepContainmentVerificationArgs([]), /--apply/)
  assert.throws(() => parseDeepContainmentVerificationArgs([
    '--apply', '--registry', '/tmp/registry.sqlite', '--artifact', '/tmp/report.json',
  ]), /--fixture/)
  assert.throws(() => parseDeepContainmentVerificationArgs([
    '--apply', '--fixture', 'descendant-timeout-v1', '--registry', './registry.sqlite', '--artifact', '/tmp/report.json',
  ]), /absolute/)
  assert.throws(() => parseDeepContainmentVerificationArgs([
    '--apply', '--apply', '--fixture', 'descendant-timeout-v1', '--registry', '/tmp/r', '--artifact', '/tmp/a',
  ]), /Duplicate/)
  assert.throws(() => parseDeepContainmentVerificationArgs([
    '--apply', '--fixture', 'descendant-timeout-v1', '--fixture', 'descendant-timeout-v1',
    '--registry', '/tmp/r', '--artifact', '/tmp/a',
  ]), /Duplicate/)
})

test('containment verifier emits only a redacted proof artifact and never enables deep research', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'deep-containment-verifier-'))
  const command = parseDeepContainmentVerificationArgs([
    '--apply', '--fixture', 'descendant-timeout-v1', '--registry', join(dir, 'registry.sqlite'), '--artifact', join(dir, 'report.json'),
  ], { NEWS_SQLITE_PATH: join(dir, 'news.sqlite'), PIPELINE_SQLITE_PATH: join(dir, 'pipeline.sqlite') })
  const expected: DeepContainmentVerificationArtifact = {
    schemaVersion: 'myboon.deep_containment_verification.v1', fixture: 'descendant-timeout-v1',
    executedAt: '2026-08-26T00:00:00.000Z', systemdAvailable: true, timeoutObserved: true,
    descendantUnitInactive: true, registryCleared: true, temporaryWorkspaceRemoved: true,
    passed: true, enablesDeepResearch: false,
  }
  let written: unknown
  try {
    const actual = await runDeepContainmentVerification(command, {
      execute: async () => expected,
      writeArtifact: async (path, artifact) => { written = { path, artifact } },
    })
    assert.deepEqual(actual, expected)
    assert.deepEqual(written, { path: join(dir, 'report.json'), artifact: expected })
    assert.equal(JSON.stringify(actual).includes('traceId'), false)
    assert.equal(JSON.stringify(actual).includes('tempPath'), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('containment verifier performs zero execution or artifact writes for protected or existing targets', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'deep-containment-safety-'))
  const newsPath = join(dir, 'news.sqlite')
  const existingArtifact = join(dir, 'existing.json')
  writeFileSync(existingArtifact, 'do not replace')
  let executions = 0
  let writes = 0
  const dependencies = {
    execute: async () => { executions += 1; throw new Error('must not execute') },
    writeArtifact: async () => { writes += 1 },
  }
  try {
    const protectedCommand = parseDeepContainmentVerificationArgs([
      '--apply', '--fixture', 'descendant-timeout-v1', '--registry', newsPath, '--artifact', join(dir, 'report.json'),
    ], { NEWS_SQLITE_PATH: newsPath, PIPELINE_SQLITE_PATH: join(dir, 'pipeline.sqlite') })
    await assert.rejects(runDeepContainmentVerification(protectedCommand, dependencies), /protected/)
    const existingCommand = parseDeepContainmentVerificationArgs([
      '--apply', '--fixture', 'descendant-timeout-v1', '--registry', join(dir, 'scratch.sqlite'), '--artifact', existingArtifact,
    ], { NEWS_SQLITE_PATH: newsPath, PIPELINE_SQLITE_PATH: join(dir, 'pipeline.sqlite') })
    await assert.rejects(runDeepContainmentVerification(existingCommand, dependencies), /already exists/)
    assert.equal(executions, 0)
    assert.equal(writes, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('containment artifact publication is no-replace even if a target appears after execution starts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'deep-containment-race-'))
  const artifactPath = join(dir, 'report.json')
  const command = parseDeepContainmentVerificationArgs([
    '--apply', '--fixture', 'descendant-timeout-v1', '--registry', join(dir, 'scratch.sqlite'), '--artifact', artifactPath,
  ], { NEWS_SQLITE_PATH: join(dir, 'news.sqlite'), PIPELINE_SQLITE_PATH: join(dir, 'pipeline.sqlite') })
  const expected: DeepContainmentVerificationArtifact = {
    schemaVersion: 'myboon.deep_containment_verification.v1', fixture: 'descendant-timeout-v1',
    executedAt: '2026-08-26T00:00:00.000Z', systemdAvailable: true, timeoutObserved: true,
    descendantUnitInactive: true, registryCleared: true, temporaryWorkspaceRemoved: true,
    passed: true, enablesDeepResearch: false,
  }
  try {
    await assert.rejects(runDeepContainmentVerification(command, {
      execute: async () => { writeFileSync(artifactPath, 'concurrent-owner', { mode: 0o600 }); return expected },
    }), /EEXIST|exist/i)
    assert.equal(readFileSync(artifactPath, 'utf8'), 'concurrent-owner')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('containment artifact is published mode-0600 after a successful explicit scratch run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'deep-containment-mode-'))
  const artifactPath = join(dir, 'report.json')
  const command = parseDeepContainmentVerificationArgs([
    '--apply', '--fixture', 'descendant-timeout-v1', '--registry', join(dir, 'scratch.sqlite'), '--artifact', artifactPath,
  ], { NEWS_SQLITE_PATH: join(dir, 'news.sqlite'), PIPELINE_SQLITE_PATH: join(dir, 'pipeline.sqlite') })
  const expected: DeepContainmentVerificationArtifact = {
    schemaVersion: 'myboon.deep_containment_verification.v1', fixture: 'descendant-timeout-v1',
    executedAt: '2026-08-26T00:00:00.000Z', systemdAvailable: true, timeoutObserved: true,
    descendantUnitInactive: true, registryCleared: true, temporaryWorkspaceRemoved: true,
    passed: true, enablesDeepResearch: false,
  }
  try {
    await runDeepContainmentVerification(command, { execute: async () => expected })
    assert.equal(statSync(artifactPath).mode & 0o777, 0o600)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
