import type { RetrievedEvidenceArtifact } from '../research-engine/deterministic-retrieval'
import type { RetrievedEvidence } from './contracts'
import { validateRetrievedEvidence } from './validation'

/** Explicit boundary from the deterministic retriever's owned artifact type. */
export function adaptRetrievedEvidenceArtifact(
  artifact: RetrievedEvidenceArtifact,
): RetrievedEvidence {
  return validateRetrievedEvidence({ ...artifact })
}
