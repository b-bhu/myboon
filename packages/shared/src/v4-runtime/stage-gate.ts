/**
 * V4 stage on/off gate (#512): the shared gate behind the scout (#444) and
 * analyst (#512) entrypoints. The gate runs before any DB client or network is
 * created: when the gate decides "off", it never calls `run`, so no client,
 * pool, or socket is ever opened for a disabled stage. Each stage's PM2 entry
 * runs its `src/run.ts`, which is wrapped by this gate.
 */

/** Env is NodeJS.ProcessEnv-shaped: keys may be absent or undefined. */
export type ProcessEnvLike = Record<string, string | undefined>

/** The exact string that turns a stage on; anything else is off. */
const ENABLED_VALUE = 'true'

/**
 * True only when env[flag] is exactly 'true'. An unset or differently-cased
 * value ('TRUE', '1', ...) is off. Env defaults to process.env.
 */
export function isStageEnabled(flag: string, env: ProcessEnvLike = process.env): boolean {
  return env[flag] === ENABLED_VALUE
}

export interface RunGatedStageOptions {
  /** The env key that turns the stage on, e.g. ANALYST_ENABLED. */
  flag: string
  /** The stage name in the disabled log line, e.g. 'analyst'. */
  stage: string
  /** Env to read; defaults to process.env. */
  env?: ProcessEnvLike
  /** Process terminator; defaults to process.exit (a test fake may just record). */
  exit?: (code: number) => never | void
  /** The stage work itself: any client factory / runner this calls belongs here. */
  run: () => Promise<void>
  /** Line sink for the disabled log line; defaults to one stdout line. */
  log?: (line: string) => void
  /** Message for the disabled line; defaults to `<stage> disabled (<flag> != "true"); exiting`. */
  disabledMsg?: string
}

/**
 * Off: one JSON info line naming the stage and flag, exit 0, and `run` is never
 * called. On: await run().
 */
export async function runGatedStage(opts: RunGatedStageOptions): Promise<void> {
  const env = opts.env ?? process.env
  const exit = opts.exit ?? process.exit
  const log = opts.log ?? ((line: string) => { process.stdout.write(line + '\n') })

  if (!isStageEnabled(opts.flag, env)) {
    const msg = opts.disabledMsg ?? `${opts.stage} disabled (${opts.flag} != "true"); exiting`
    log(JSON.stringify({ level: 'info', stage: opts.stage, msg }))
    exit(0)
    return
  }

  await opts.run()
}