import {
  assertActiveCutoverReceipts,
  FeedV3CutoverReceiptError,
} from './cutover-receipt'
import type { CutoverStage } from './cutover-receipt'
import type { FeedV3Source } from './runtime-config'

export const CUTOVER_READINESS_SCHEMA_VERSION = 'myboon.feed_v3_cutover_readiness.v1' as const
export const CUTOVER_READINESS_PROGRAM = 'phase1' as const

export type CutoverReadinessOutcome = 'ready' | 'missing' | 'expired' | 'invalid'
export type CutoverReadinessPair = { source: FeedV3Source; stage: CutoverStage }

export interface CutoverReadinessPairReport {
  pair: CutoverReadinessPair
  outcome: CutoverReadinessOutcome
  ready: boolean
  note: string
}

export interface CutoverReadinessReport {
  schemaVersion: typeof CUTOVER_READINESS_SCHEMA_VERSION
  program: typeof CUTOVER_READINESS_PROGRAM
  reportedAt: string
  ready: boolean
  pairs: ReadonlyArray<CutoverReadinessPairReport>
}

/**
 * Phase 1 cutover readiness scope: shared research and entity ownership for the
 * news and polymarket sources. Requested pairs outside this scope are rejected.
 */
export const PHASE_1_READINESS_PAIRS: readonly CutoverReadinessPair[] = Object.freeze([
  { source: 'news', stage: 'research' },
  { source: 'news', stage: 'entity' },
  { source: 'polymarket', stage: 'research' },
  { source: 'polymarket', stage: 'entity' },
])

export interface CutoverReadinessReceiptRef {
  source: FeedV3Source
  stage: CutoverStage
  expiresAt: string
}

/**
 * Read-only access to the cutover manifest used by the shared gating contract.
 * The reporter reads the manifest only through this loader so evaluation stays
 * explicit and testable; it never reads SQLite, Supabase, or claims work.
 */
export interface CutoverReadinessLoader {
  /** On-disk manifest path consumed by the shared cutover gating contract. */
  manifestPath: string
  /** Read bounded receipt identities/timestamps for the report (read-only). */
  readReceipts(): ReadonlyArray<CutoverReadinessReceiptRef>
}

export class CutoverReadinessError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CutoverReadinessError'
  }
}

export function createFileCutoverReadinessLoader(manifestPath: string): CutoverReadinessLoader {
  return {
    manifestPath,
    readReceipts(): ReadonlyArray<CutoverReadinessReceiptRef> {
      const manifest = assertActiveCutoverReceipts({ path: manifestPath, required: [] })
      return manifest.receipts.map((receipt) => ({
        source: receipt.sourceType,
        stage: receipt.stage,
        expiresAt: receipt.expiresAt,
      }))
    },
  }
}

/**
 * Build a typed, bounded Phase 1 cutover readiness report for the requested
 * source/stage pairs. Evaluation is read-only: it reuses the shared cutover
 * gating contract (`assertActiveCutoverReceipts`) for every binding, expiry,
 * and minimum-sample check rather than re-implementing or weakening them.
 */
export function reportCutoverReadiness(input: {
  pairs: ReadonlyArray<CutoverReadinessPair>
  loader: CutoverReadinessLoader
  now?: Date
}): CutoverReadinessReport {
  const requested = dedupeAndValidate(input.pairs)
  const now = input.now ?? new Date()

  let refs: ReadonlyArray<CutoverReadinessReceiptRef> = []
  let refsLoaded = true
  try {
    refs = input.loader.readReceipts()
  } catch {
    refsLoaded = false
  }

  const pairs = requested.map((pair) => evaluatePair(pair, { refs, refsLoaded }, input.loader, now))
  return {
    schemaVersion: CUTOVER_READINESS_SCHEMA_VERSION,
    program: CUTOVER_READINESS_PROGRAM,
    reportedAt: now.toISOString(),
    ready: pairs.every((pair) => pair.ready),
    pairs,
  }
}

function evaluatePair(
  pair: CutoverReadinessPair,
  manifest: { refs: ReadonlyArray<CutoverReadinessReceiptRef>, refsLoaded: boolean },
  loader: CutoverReadinessLoader,
  now: Date,
): CutoverReadinessPairReport {
  if (!manifest.refsLoaded) {
    return { pair, outcome: 'invalid', ready: false, note: 'cutover receipt data could not be read' }
  }
  const ref = manifest.refs.find(
    (candidate) => candidate.source === pair.source && candidate.stage === pair.stage,
  )
  if (!ref) {
    return { pair, outcome: 'missing', ready: false, note: 'cutover receipt is missing' }
  }
  try {
    assertActiveCutoverReceipts({
      path: loader.manifestPath,
      required: [{ sourceType: pair.source, stage: pair.stage }],
      now,
    })
    return { pair, outcome: 'ready', ready: true, note: 'cutover receipt is active' }
  } catch (error) {
    if (error instanceof FeedV3CutoverReceiptError && isExpired(ref, now)) {
      return { pair, outcome: 'expired', ready: false, note: 'cutover receipt is expired' }
    }
    return { pair, outcome: 'invalid', ready: false, note: 'cutover receipt binding failed' }
  }
}

function isExpired(ref: CutoverReadinessReceiptRef, now: Date): boolean {
  const expiry = Date.parse(ref.expiresAt)
  return Number.isFinite(expiry) && expiry <= now.getTime()
}

function identity(pair: CutoverReadinessPair): string {
  return `${pair.stage}:${pair.source}`
}

function dedupeAndValidate(
  pairs: ReadonlyArray<CutoverReadinessPair>,
): Array<CutoverReadinessPair> {
  if (pairs.length === 0) {
    throw new CutoverReadinessError('At least one cutover readiness pair is required')
  }
  const supported = new Set(PHASE_1_READINESS_PAIRS.map(identity))
  const seen = new Set<string>()
  const result: Array<CutoverReadinessPair> = []
  for (const pair of pairs) {
    const id = identity(pair)
    if (!supported.has(id)) throw new CutoverReadinessError(`Unsupported cutover readiness pair: ${id}`)
    if (seen.has(id)) continue
    seen.add(id)
    result.push(pair)
  }
  result.sort((a, b) => identity(a).localeCompare(identity(b)))
  return result
}
