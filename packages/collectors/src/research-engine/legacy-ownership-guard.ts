import { assertActiveCutoverReceipts } from '../signal-platform/cutover-receipt'
import { loadFeedV3RuntimeConfig, type FeedV3Source } from '../signal-platform/runtime-config'

export type LegacyResearchSource = Extract<FeedV3Source, 'news' | 'polymarket'>

export interface LegacyResearchOwnershipDecision {
  sourceType: LegacyResearchSource
  owner: 'legacy' | 'shared'
}

/**
 * Resolve legacy/shared Research ownership before a legacy runner constructs
 * SQLite, Supabase, browser, or provider dependencies.
 */
export function legacyResearchOwnership(
  sourceType: LegacyResearchSource,
  env: Readonly<Record<string, string | undefined>> = process.env,
  now?: Date,
): LegacyResearchOwnershipDecision {
  const config = loadFeedV3RuntimeConfig(env)
  if (!config.legacyResearchDisabledSources.has(sourceType)) {
    return Object.freeze({ sourceType, owner: 'legacy' })
  }
  if (config.researchMode !== 'active' || !config.researchActiveSources.has(sourceType)) {
    throw new Error(
      `Legacy Research ownership for ${sourceType} is disabled without active shared ownership; refusing all claims.`,
    )
  }
  if (!config.cutoverReceiptPath) {
    throw new Error(`Active shared Research ownership for ${sourceType} requires a cutover receipt.`)
  }
  assertActiveCutoverReceipts({
    path: config.cutoverReceiptPath,
    required: [{ sourceType, stage: 'research' }],
    ...(now ? { now } : {}),
  })
  return Object.freeze({ sourceType, owner: 'shared' })
}

export async function runLegacyResearchWhenOwned<T>(input: {
  sourceType: LegacyResearchSource
  env?: Readonly<Record<string, string | undefined>>
  now?: Date
  run: () => Promise<T> | T
}): Promise<{ ownership: LegacyResearchOwnershipDecision, value?: T }> {
  const ownership = legacyResearchOwnership(input.sourceType, input.env, input.now)
  if (ownership.owner === 'shared') return { ownership }
  return { ownership, value: await input.run() }
}
