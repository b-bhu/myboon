import {
  FEED_V3_RUNTIME_CONTROL_PATH_ENV,
  FileRuntimeControlStore,
  resolveRuntimeControlPath,
  type RuntimeControlAction,
  type RuntimeControlOperationResult,
  type RuntimeControlStage,
} from './runtime-control'

export interface ParsedRuntimeControlArgs {
  stage: RuntimeControlStage
  action: RuntimeControlAction
  apply: boolean
  path?: string
}

export interface RunRuntimeControlCommandOptions {
  env?: Readonly<Record<string, string | undefined>>
  now?: () => Date
  createStore?: (path: string) => Pick<FileRuntimeControlStore, 'run'>
}

/** Pure parsing; dry-run remains the default unless --apply is explicit. */
export function parseRuntimeControlArgs(args: string[]): ParsedRuntimeControlArgs {
  let stage: RuntimeControlStage | undefined
  let action: RuntimeControlAction | undefined
  let path: string | undefined
  let apply = false
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--apply') {
      if (apply) throw new Error('--apply may be provided only once')
      apply = true
      continue
    }
    const value = args[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`)
    if (argument === '--stage') {
      if (stage !== undefined) throw new Error('--stage may be provided only once')
      if (value !== 'research' && value !== 'entity') throw new Error(`Unsupported runtime stage: ${value}`)
      stage = value
    } else if (argument === '--action') {
      if (action !== undefined) throw new Error('--action may be provided only once')
      if (value !== 'drain' && value !== 'resume') throw new Error(`Unsupported runtime action: ${value}`)
      action = value
    } else if (argument === '--path') {
      if (path !== undefined) throw new Error('--path may be provided only once')
      if (!value.trim()) throw new Error('--path must not be blank')
      path = value
    } else {
      throw new Error(`Unknown runtime control argument: ${argument}`)
    }
    index += 1
  }
  if (stage === undefined) throw new Error('--stage is required')
  if (action === undefined) throw new Error('--action is required')
  return { stage, action, apply, ...(path ? { path } : {}) }
}

export function runRuntimeControlCommand(
  args: string[],
  options: RunRuntimeControlCommandOptions = {},
): RuntimeControlOperationResult {
  const parsed = parseRuntimeControlArgs(args)
  const env = options.env ?? process.env
  const path = parsed.path ?? resolveRuntimeControlPath(env)
  const store = (options.createStore ?? ((value) => new FileRuntimeControlStore(value)))(path)
  return store.run({
    stage: parsed.stage,
    action: parsed.action,
    apply: parsed.apply,
    now: (options.now?.() ?? new Date()).toISOString(),
  })
}

export { FEED_V3_RUNTIME_CONTROL_PATH_ENV }
