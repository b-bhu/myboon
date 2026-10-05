import { assertActiveCutoverReceipts } from '../signal-platform/cutover-receipt'
import { sourceOwnershipAllows } from '../signal-platform/source-ownership'
import { legacyEntitySourcePath } from './source-ownership-write-guard'
import {
  loadFeedV3RuntimeConfig,
  type FeedV3Source,
} from '../signal-platform/runtime-config'

export type LegacyEntitySource = Extract<FeedV3Source, 'news' | 'polymarket'>

export interface LegacyEntityOwnershipDecision {
  sourceType: LegacyEntitySource
  owner: 'legacy' | 'shared'
}

/**
 * Resolve the single Entity claimer from the same reviewed runtime topology
 * used by the shared worker. A legacy-disabled source is accepted only when
 * active shared ownership and its exact source/stage receipt are valid.
 *
 * This function intentionally performs no database, provider, queue, or
 * network work. Call it before constructing any legacy runner dependencies.
 */
export function legacyEntityOwnership(
  sourceType: LegacyEntitySource,
  env: Readonly<Record<string, string | undefined>> = process.env,
  now?: Date,
): LegacyEntityOwnershipDecision {
  const authority = {databasePath: legacyEntitySourcePath(sourceType,env),source: sourceType,domain:'entity' as const,env}
  if (!sourceOwnershipAllows({...authority,owner:'legacy'})) {
    if (sourceOwnershipAllows({...authority,owner:'shared'})) return Object.freeze({sourceType,owner:'shared'})
    throw new Error(`Persistent Entity ownership for ${sourceType} is paused or unavailable; refusing claims`)
  }
  const config = loadFeedV3RuntimeConfig(env)
  if (!config.legacyEntityDisabledSources.has(sourceType)) {
    return Object.freeze({ sourceType, owner: 'legacy' })
  }

  if (config.entityMode !== 'active' || !config.entityActiveSources.has(sourceType)) {
    throw new Error(
      `Legacy Entity ownership for ${sourceType} is disabled without active shared ownership; refusing all claims.`,
    )
  }
  if (!config.cutoverReceiptPath) {
    throw new Error(`Active shared Entity ownership for ${sourceType} requires a cutover receipt.`)
  }
  assertActiveCutoverReceipts({
    path: config.cutoverReceiptPath,
    required: [{ sourceType, stage: 'entity' }],
    ...(now ? { now } : {}),
  })
  return Object.freeze({ sourceType, owner: 'shared' })
}

export async function runLegacyEntityWhenOwned<T>(input: {
  sourceType: LegacyEntitySource
  env?: Readonly<Record<string, string | undefined>>
  now?: Date
  run: () => Promise<T> | T
}): Promise<{ ownership: LegacyEntityOwnershipDecision, value?: T }> {
  const ownership = legacyEntityOwnership(input.sourceType, input.env, input.now)
  if (ownership.owner === 'shared') return { ownership }
  return { ownership, value: await input.run() }
}
