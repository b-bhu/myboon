/**
 * Command layer for the lane-store prune (issue #346 PR 6). Mirrors
 * src/pipeline-store/prune-command.ts: dry run by default, JSON audit on
 * stdout, `--apply` to actually delete, `--now=<ISO>` for tests.
 */
import type { SqliteLane } from './paths'
import { LANE_SQLITE_FILENAMES, resolveLaneSqlitePathFromEnv } from './paths'
import { runLaneStorePrune, type LaneStorePruneAudit } from './prune'

export interface LaneStorePruneCommandInput {
  apply: boolean
  now?: Date
}

export function parseLaneStorePruneArgs(args: string[]): LaneStorePruneCommandInput {
  let apply = false
  let now: Date | undefined
  for (const arg of args) {
    if (arg === '--apply') {
      if (apply) throw new Error('--apply may be supplied only once')
      apply = true
      continue
    }
    if (arg.startsWith('--now=')) {
      if (now) throw new Error('--now may be supplied only once')
      const raw = arg.slice('--now='.length)
      const parsed = new Date(raw)
      if (Number.isNaN(parsed.getTime())) throw new Error(`--now must be an ISO timestamp, got '${raw}'`)
      now = parsed
      continue
    }
    throw new Error(`Unknown prune argument: ${arg}`)
  }
  return { apply, ...(now ? { now } : {}) }
}

/**
 * Resolves every lane store path through resolveLaneSqlitePathFromEnv (a
 * retired filename in NEWS_SQLITE_PATH / PIPELINE_SQLITE_PATH throws before
 * anything opens) and prunes. Env is injectable for tests.
 */
export async function runLaneStorePruneCommand(
  input: LaneStorePruneCommandInput,
  options?: { env?: NodeJS.ProcessEnv | Record<string, string | undefined> },
): Promise<LaneStorePruneAudit> {
  const env = options?.env
  const lanes = Object.keys(LANE_SQLITE_FILENAMES) as SqliteLane[]
  const paths = Object.fromEntries(
    lanes.map((lane) => [lane, resolveLaneSqlitePathFromEnv(lane, env ? { ...env } : process.env)]),
  ) as Record<SqliteLane, string>
  return runLaneStorePrune({ paths, now: input.now, apply: input.apply })
}