import type {
  EntityKnowledgeMemoryV1,
  EntityMemoryChangePage,
} from '../entity-manager/entity-knowledge-reader'

export type XDeskAction = 'recommend' | 'skip'
export type XDeskCandidateStatus = 'pending' | 'retry_wait' | 'ready' | 'skipped' | 'failed'

export interface XDeskEntity {
  id: string
  slug: string
  name: string
  type: string
  summary: string | null
}

export interface XDeskReviewInput {
  candidateId: string
  entity: XDeskEntity
  memory: EntityKnowledgeMemoryV1
}

export interface XDeskDecision {
  candidateId: string
  action: XDeskAction
  postText: string | null
  rationale: string
  confidence: number
}

export interface XDeskDecisionResponse {
  decisions: XDeskDecision[]
}

export interface XDeskProvider {
  decide(inputs: XDeskReviewInput[], priorPosts: string[], maxRecommendations: number): Promise<XDeskDecision[]>
}

export interface XDeskSource {
  getChanges(afterCursor: string, limit: number): Promise<EntityMemoryChangePage>
  getEntities(entityIds: string[]): Promise<Map<string, XDeskEntity>>
}

export interface XDeskStoredCandidate {
  id: string
  memoryId: string
  memoryUpdatedAt: string
  changedAt: string
  entityId: string
  entitySlug: string | null
  entityName: string | null
  status: XDeskCandidateStatus
  postText: string | null
  rationale: string | null
  confidence: number | null
  attemptCount: number
  lastError: string | null
  memory: EntityKnowledgeMemoryV1
  createdAt: string
  updatedAt: string
}

export interface XDeskRunResult {
  observedAt: string
  changesScanned: number
  newsChangesQueued: number
  candidatesReviewed: number
  recommended: number
  skipped: number
  failed: number
  intakeHasMore: boolean
  recommendations: Array<{
    candidateId: string
    entityName: string
    postText: string
    rationale: string
    confidence: number
    sourceMemoryId: string
  }>
}
