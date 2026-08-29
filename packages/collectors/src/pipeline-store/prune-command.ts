import { isAbsolute, resolve } from 'node:path'
import { pruneOldBackups, type BackupPruneAudit } from './backup'

export interface PruneCommandInput {
  store: 'pipeline' | 'news'
  backupDir: string
  keep: number
  limit: number
  apply: boolean
}

export async function runPruneCommand(
  input: PruneCommandInput,
  prune: typeof pruneOldBackups = pruneOldBackups,
): Promise<BackupPruneAudit> {
  return prune({
    backupDir: input.backupDir,
    prefix: input.store === 'pipeline' ? 'pipeline-' : 'news-',
    keep: input.keep,
    limit: input.limit,
    apply: input.apply,
  })
}

export function parsePruneCommandArgs(args: string[]): PruneCommandInput {
  const values = new Map<string, string>()
  let apply = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--apply') { apply = true; continue }
    if (!['--store', '--backup-dir', '--keep', '--limit'].includes(arg)) {
      throw new Error(`Unknown prune argument: ${arg}`)
    }
    if (values.has(arg)) throw new Error(`${arg} may be supplied only once`)
    const value = args[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`)
    values.set(arg, value)
    index += 1
  }

  const store = values.get('--store')
  if (store !== 'pipeline' && store !== 'news') throw new Error('--store must be pipeline or news')
  const backupDir = values.get('--backup-dir')
  if (!backupDir) throw new Error('--backup-dir is required')
  if (!isAbsolute(backupDir)) throw new Error('--backup-dir must be an absolute path')
  const keep = boundedInteger(values.get('--keep'), '--keep', 1, 10_000)
  const limit = boundedInteger(values.get('--limit'), '--limit', 1, 1_000)
  return { store, backupDir: resolve(backupDir), keep, limit, apply }
}

function boundedInteger(raw: string | undefined, flag: string, minimum: number, maximum: number): number {
  if (raw === undefined) throw new Error(`${flag} is required`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${flag} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}
