import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import {
  evidenceArtifactReferences,
  type OperationalEvidence,
  type RawArtifactReferenceV1,
  validateLiveLoadEvidence,
  validateLiveSoakEvidence,
  validateProviderOutageRehearsalEvidence,
  validateRollbackRehearsalEvidence,
} from './operational-evidence'
import {
  type OperationalEvidenceKind,
  type OperationalEvidencePolicyV1,
  assertOperationalEvidencePolicyCurrent,
  validateOperationalEvidencePolicy,
} from './operational-evidence-policy'

export interface VerifiedOperationalEvidenceBundle {
  evidence: OperationalEvidence
  policy: OperationalEvidencePolicyV1
  evidenceSha256: string
  policySha256: string
  verifiedRawArtifacts: Array<{ artifactPath: string; artifactSha256: string }>
}

/**
 * Reads a reviewer-supplied policy independently from the evidence and hashes
 * every file from its raw bytes. No declared digest is accepted as proof by
 * itself.
 */
export function readOperationalEvidenceBundle(input: {
  kind: OperationalEvidenceKind
  evidencePath: string
  policyPath: string
  now?: Date
}): VerifiedOperationalEvidenceBundle {
  const evidencePath = absolute(input.evidencePath, '--input')
  const policyPath = absolute(input.policyPath, '--policy')
  if (canonicalExisting(evidencePath, 'evidence') === canonicalExisting(policyPath, 'policy')) {
    throw new Error('--input and --policy must refer to different files')
  }

  const policyFile = readJsonFile(policyPath, 'policy')
  const policy = validateOperationalEvidencePolicy(policyFile.value)
  assertOperationalEvidencePolicyCurrent(policy, input.now)
  const evidenceFile = readJsonFile(evidencePath, 'evidence')
  const evidence = validateByKind(input.kind, evidenceFile.value, policy)
  if (evidence.policySha256 !== policyFile.sha256) {
    throw new Error('evidence policySha256 does not match independently supplied policy bytes')
  }

  const verifiedRawArtifacts = verifyOperationalEvidenceRawArtifacts(evidence, [evidencePath, policyPath])
  return {
    evidence,
    policy,
    evidenceSha256: evidenceFile.sha256,
    policySha256: policyFile.sha256,
    verifiedRawArtifacts,
  }
}

export function verifyOperationalEvidenceRawArtifacts(
  evidence: OperationalEvidence,
  disallowedPaths: string[] = [],
): Array<{ artifactPath: string; artifactSha256: string }> {
  const references = evidenceArtifactReferences(evidence)
  const forbidden = new Set(disallowedPaths.map((path) => canonicalCandidate(path)))
  const seen = new Set<string>()
  return references.map((reference) => {
    const canonicalPath = canonicalExisting(reference.artifactPath, 'raw')
    if (forbidden.has(canonicalPath)) {
      throw new Error('raw artifact paths must not alias the evidence or policy file')
    }
    if (seen.has(canonicalPath)) throw new Error(`duplicate raw artifact path: ${reference.artifactPath}`)
    seen.add(canonicalPath)
    verifyRawArtifact(reference, canonicalPath)
    return { ...reference }
  })
}

/** Compatibility name for callers of the original one-file validator. */
export function readOperationalEvidence(input: {
  kind: OperationalEvidenceKind
  inputPath: string
  policyPath: string
  now?: Date
}): OperationalEvidence {
  return readOperationalEvidenceBundle({
    kind: input.kind,
    evidencePath: input.inputPath,
    policyPath: input.policyPath,
    now: input.now,
  }).evidence
}

function validateByKind(
  kind: OperationalEvidenceKind,
  value: unknown,
  policy: OperationalEvidencePolicyV1,
): OperationalEvidence {
  if (kind === 'rollback') return validateRollbackRehearsalEvidence(value, policy)
  if (kind === 'live-load') return validateLiveLoadEvidence(value, policy)
  if (kind === 'live-soak') return validateLiveSoakEvidence(value, policy)
  return validateProviderOutageRehearsalEvidence(value, policy)
}

function verifyRawArtifact(reference: RawArtifactReferenceV1, canonicalPath: string): void {
  let bytes: Buffer
  try { bytes = readFileSync(canonicalPath) } catch { throw new Error(`raw artifact could not be read: ${reference.artifactPath}`) }
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== reference.artifactSha256) {
    throw new Error(`raw artifact SHA-256 mismatch: ${reference.artifactPath}`)
  }
}

function readJsonFile(path: string, label: string): { value: unknown; sha256: string } {
  let bytes: Buffer
  try { bytes = readFileSync(path) } catch { throw new Error(`${label} artifact could not be read`) }
  let value: unknown
  try { value = JSON.parse(bytes.toString('utf8')) as unknown } catch { throw new Error(`${label} artifact is not valid JSON`) }
  return { value, sha256: createHash('sha256').update(bytes).digest('hex') }
}

function absolute(path: string, flag: string): string {
  if (!path.trim() || !isAbsolute(path)) throw new Error(`${flag} must be an absolute path`)
  return resolve(path)
}

function canonicalExisting(path: string, label: string): string {
  try {
    const canonical = realpathSync(path)
    if (!statSync(canonical).isFile()) throw new Error('not a regular file')
    return canonical
  } catch {
    throw new Error(`${label} artifact must be a readable regular file`)
  }
}

function canonicalCandidate(path: string): string {
  try { return realpathSync(path) } catch { return resolve(path) }
}
