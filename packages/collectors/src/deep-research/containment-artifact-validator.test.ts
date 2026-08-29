import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  parseDeepContainmentArtifactValidationArgs,
  validateDeepContainmentArtifact,
} from './containment-artifact-validator'
import {
  createDeepContainmentVerificationArtifact,
  type DeepContainmentVerificationArtifact,
  type DeepContainmentVerificationOutcome,
} from './containment-verification'

const outcome: DeepContainmentVerificationOutcome = {
  fixture: 'descendant-timeout-v1', executedAt: '2026-08-26T00:00:00.000Z',
  systemdAvailable: true, timeoutObserved: true, descendantUnitInactive: true,
  registryCleared: true, temporaryWorkspaceRemoved: true, passed: true,
  enablesDeepResearch: false,
}

test('offline validator recomputes artifact, configuration, fixture, and executable identities', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'deep-artifact-validator-'))
  const artifactPath = join(dir, 'artifact.json')
  const fixturePath = join(dir, 'fixture.cjs')
  const executablePath = join(dir, 'worker')
  const fixture = Buffer.from('fixture-v1')
  const executable = Buffer.from('host-executable-v1')
  writeFileSync(fixturePath, fixture)
  writeFileSync(executablePath, executable)
  const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
  try {
    const artifact = await createDeepContainmentVerificationArtifact(outcome, {
      fixtureSha256: sha(fixture), hostExecutableSha256: sha(executable),
    })
    writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`)
    const report = await validateDeepContainmentArtifact({ artifactPath, fixturePath, hostExecutablePath: executablePath },
      () => new Date('2026-08-27T00:00:00.000Z'))
    assert.equal(report.offline, true)
    assert.equal(report.complete, true)
    assert.equal(report.passed, true)
    assert.deepEqual(report.checks, {
      artifactPayload: 'passed', configuration: 'passed', fixture: 'passed', hostExecutable: 'passed',
    })
    assert.match(report.artifactSha256, /^[a-f0-9]{64}$/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('offline validator reports unavailable identity inputs as incomplete and rejects relative artifact paths', async () => {
  assert.throws(() => parseDeepContainmentArtifactValidationArgs(['--artifact', './artifact.json']), /absolute/)
  const dir = mkdtempSync(join(tmpdir(), 'deep-artifact-incomplete-'))
  const artifactPath = join(dir, 'artifact.json')
  try {
    const artifact = await createDeepContainmentVerificationArtifact(outcome, {
      fixtureSha256: 'a'.repeat(64), hostExecutableSha256: 'b'.repeat(64),
    })
    writeFileSync(artifactPath, JSON.stringify(artifact))
    const report = await validateDeepContainmentArtifact({
      artifactPath, fixturePath: join(dir, 'missing-fixture'), hostExecutablePath: join(dir, 'missing-worker'),
    })
    assert.equal(report.complete, false)
    assert.equal(report.passed, false)
    assert.equal(report.checks.fixture, 'incomplete')
    assert.equal(report.checks.hostExecutable, 'incomplete')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('offline validator detects canonical payload and configuration tampering', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'deep-artifact-tamper-'))
  const artifactPath = join(dir, 'artifact.json')
  const fixturePath = join(dir, 'fixture.cjs')
  const executablePath = join(dir, 'worker')
  writeFileSync(fixturePath, 'fixture')
  writeFileSync(executablePath, 'worker')
  const sha = (value: string) => createHash('sha256').update(value).digest('hex')
  try {
    const artifact = await createDeepContainmentVerificationArtifact(outcome, {
      fixtureSha256: sha('fixture'), hostExecutableSha256: sha('worker'),
    })
    const tampered = JSON.parse(JSON.stringify(artifact)) as DeepContainmentVerificationArtifact
    tampered.identity.configurationSha256 = 'c'.repeat(64)
    writeFileSync(artifactPath, JSON.stringify(tampered))
    const report = await validateDeepContainmentArtifact({ artifactPath, fixturePath, hostExecutablePath: executablePath })
    assert.equal(report.passed, false)
    assert.equal(report.checks.artifactPayload, 'mismatch')
    assert.equal(report.checks.configuration, 'mismatch')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
