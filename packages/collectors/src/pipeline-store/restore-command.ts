import { resolve } from 'node:path'
import {
  restoreNewsStore,
  restorePipelineStore,
  verifyNewsBackup,
  verifyPipelineBackup,
  type PipelineBackupVerification,
  type PipelineRestoreResult,
} from './backup'

export type RestoreStoreKind = 'pipeline' | 'news'

export interface RestoreCommandInput {
  store: RestoreStoreKind
  backupPath: string
  targetPath: string
  apply: boolean
  force: boolean
}

export type RestoreCommandResult =
  | {
    mode: 'dry_run'
    store: RestoreStoreKind
    backupPath: string
    targetPath: string
    force: boolean
    verification: PipelineBackupVerification
  }
  | {
    mode: 'apply'
    store: RestoreStoreKind
    backupPath: string
    targetPath: string
    force: boolean
    restore: PipelineRestoreResult
  }

export interface RestoreCommandPorts {
  verifyPipeline?: typeof verifyPipelineBackup
  verifyNews?: typeof verifyNewsBackup
  restorePipeline?: typeof restorePipelineStore
  restoreNews?: typeof restoreNewsStore
}

/**
 * Recovery is deliberately dry-run first and requires explicit source,
 * backup, and target paths. No default ever points at the live database.
 */
export async function runRestoreCommand(
  input: RestoreCommandInput,
  ports: RestoreCommandPorts = {},
): Promise<RestoreCommandResult> {
  const backupPath = resolveRequiredPath(input.backupPath, 'backup')
  const targetPath = resolveRequiredPath(input.targetPath, 'target')
  if (backupPath === targetPath) throw new Error('Backup and restore target must be different files')

  if (!input.apply) {
    const verify = input.store === 'pipeline'
      ? ports.verifyPipeline ?? verifyPipelineBackup
      : ports.verifyNews ?? verifyNewsBackup
    const verification = await verify(backupPath)
    return { mode: 'dry_run', store: input.store, backupPath, targetPath, force: input.force, verification }
  }

  const restore = input.store === 'pipeline'
    ? ports.restorePipeline ?? restorePipelineStore
    : ports.restoreNews ?? restoreNewsStore
  const result = await restore({ backupPath, targetPath, force: input.force })
  return { mode: 'apply', store: input.store, backupPath, targetPath, force: input.force, restore: result }
}

export function parseRestoreCommandArgs(args: string[]): RestoreCommandInput {
  let store: RestoreStoreKind | null = null
  let backupPath: string | null = null
  let targetPath: string | null = null
  let apply = false
  let force = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--apply') { apply = true; continue }
    if (arg === '--force') { force = true; continue }
    if (arg !== '--store' && arg !== '--backup' && arg !== '--target') {
      throw new Error(`Unknown restore argument: ${arg}`)
    }
    const value = args[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`)
    if (arg === '--store') {
      if (value !== 'pipeline' && value !== 'news') throw new Error('--store must be pipeline or news')
      store = value
    } else if (arg === '--backup') backupPath = value
    else targetPath = value
    index += 1
  }
  if (!store) throw new Error('--store is required')
  if (!backupPath) throw new Error('--backup is required')
  if (!targetPath) throw new Error('--target is required')
  if (force && !apply) throw new Error('--force is valid only with --apply')
  return { store, backupPath, targetPath, apply, force }
}

function resolveRequiredPath(value: string, label: string): string {
  const trimmed = value.trim()
  if (!trimmed || trimmed.includes('\0')) throw new Error(`${label} path is invalid`)
  return resolve(trimmed)
}
