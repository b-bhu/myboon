/**
 * V4 scout off-switch gate (#444).
 *
 * The gate runs before any DB client or network is created: when the gate
 * decides "off", it never calls `run`, so no client, pool, or socket is
 * ever opened for a disabled stage. When the PM2 entry is repointed to
 * `src/run.ts` after #473 merges, that runner must be wrapped by the same
 * gate.
 */

/** The exact string that turns the scout on; anything else is off. */
const SCOUT_ENABLED_VALUE = 'true'

const DISABLED_LOG_LINE = JSON.stringify({
  level: 'info',
  stage: 'scout-news',
  msg: 'scout disabled (SCOUT_ENABLED != "true"); exiting',
})

/** Env is NodeJS.ProcessEnv-shaped: keys may be absent or undefined. */
type ProcessEnvLike = Record<string, string | undefined>

/**
 * True only when env.SCOUT_ENABLED is exactly 'true'. An unset or
 * differently-cased value ('TRUE', '1', ...) is off.
 */
export function isScoutEnabled(env: ProcessEnvLike = process.env): boolean {
  return env.SCOUT_ENABLED === SCOUT_ENABLED_VALUE
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
  const env = opts.env ?? process.env
  const exit = opts.exit ?? process.exit
  const log = opts.log ?? ((line: string) => { process.stdout.write(line + '\n') })

  if (!isScoutEnabled(env)) {
    log(DISABLED_LOG_LINE)
    exit(0)
    return
  }

  await opts.run()
}