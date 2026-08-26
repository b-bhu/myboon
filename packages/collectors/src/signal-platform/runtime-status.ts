import {
  readEntityRuntimeHealthSnapshot,
  type EntityRuntimeHealthRead,
} from '../entity-manager/entity-runtime-health'
import {
  readResearchRuntimeStatusSnapshot,
  type ResearchRuntimeStatusRead,
} from '../research-engine/research-runtime-lifecycle'

export interface FeedV3RuntimeStatusAvailability {
  researchRuntime: ResearchRuntimeStatusRead
  entityRuntime: EntityRuntimeHealthRead
}

export async function readFeedV3RuntimeStatusAvailability(input: {
  researchPath: string
  researchStaleAfterMs: number
  entityPath: string
  entityStaleAfterMs: number
}, ports: {
  readResearch?: typeof readResearchRuntimeStatusSnapshot
  readEntity?: typeof readEntityRuntimeHealthSnapshot
} = {}): Promise<FeedV3RuntimeStatusAvailability> {
  const [researchRuntime, entityRuntime] = await Promise.all([
    (ports.readResearch ?? readResearchRuntimeStatusSnapshot)({
      path: input.researchPath,
      staleAfterMs: input.researchStaleAfterMs,
    }).catch(() => ({ availability: 'invalid' as const, snapshot: null })),
    (ports.readEntity ?? readEntityRuntimeHealthSnapshot)({
      path: input.entityPath,
      staleAfterMs: input.entityStaleAfterMs,
    }).catch(() => ({ availability: 'invalid' as const, snapshot: null })),
  ])
  return { researchRuntime, entityRuntime }
}
