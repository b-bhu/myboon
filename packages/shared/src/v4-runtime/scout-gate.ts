/**
 * V4 scout off-switch gate (#444), the scout instance of the shared stage gate
 * (#512). The gate runs before any DB client or network is created: when the
 * gate decides "off", it never calls `run`, so no client, pool, or socket is
 * ever opened for a disabled stage. The PM2 entry runs
 * `src/run.ts`, which is wrapped by this
 * gate.
 */
import { isStageEnabled, runGatedStage, type ProcessEnvLike } from './stage-gate'

const SCOUT_ENABLED_FLAG = 'SCOUT_ENABLED'
const SCOUT_DISABLED_MSG = 'scout disabled (SCOUT_ENABLED != "true"); exiting'

/**
 * True only when env.SCOUT_ENABLED is exactly 'true'. An unset or
 * differently-cased value ('TRUE', '1', ...) is off.
 */
export function isScoutEnabled(env: ProcessEnvLike = process.env): boolean {
  return isStageEnabled(SCOUT_ENABLED_FLAG, env)
}

export interface RunGatedScoutOptions {
  /** Env to read; defaults to process.env. */
  env?: ProcessEnvLike
  /** Process terminator; defaults to process.exit (a test fake may just record). */
  exit?: (code: number) => never | void
  /** The scout work itself: any client factory / runner this calls belongs here. */
  run: () => Promise<void>
  /** Line sink for the disabled log line; defaults to one stdout line. */
  log?: (line: string) => void
}

/**
 * Off: one JSON info line, exit 0, and `run` is never called. On: await run().
 */
export async function runGatedScout(opts: RunGatedScoutOptions): Promise<void> {
  await runGatedStage({
    flag: SCOUT_ENABLED_FLAG,
    stage: 'scout-news',
    disabledMsg: SCOUT_DISABLED_MSG,
    env: opts.env,
    exit: opts.exit,
    log: opts.log,
    run: opts.run,
  })
}