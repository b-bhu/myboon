import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { readSourceOwnership, type OwnershipSqliteDatabase } from '../signal-platform/source-ownership'
import { SqliteSignalPlatformStore } from '../signal-platform/sqlite-platform-store'

export function researchOperatorArguments(args: readonly string[], allowed: readonly string[]): Record<string, string> {
  const output: Record<string, string> = {}
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]?.replace(/^--/, '')
    const value = args[index + 1]
    if (!args[index]?.startsWith('--') || !allowed.includes(key) || !value || value.startsWith('--') || output[key]) {
      throw new Error(`Expected unique named arguments: ${allowed.map((item) => `--${item}`).join(' ')}`)
    }
    output[key] = value
  }
  return output
}

export function openResearchOperatorStore(input: { source: string, databasePath: string, readOnly?: boolean }): SqliteSignalPlatformStore {
  if (input.source !== 'news' && input.source !== 'polymarket') throw new Error('Research operator source must be news or polymarket')
  const path = resolve(input.databasePath)
  if (!existsSync(path)) throw new Error('Explicit source database does not exist')
  return new SqliteSignalPlatformStore(path, input.source, { readOnly: input.readOnly })
}

export function requirePausedResearchSource(input: { source: string, databasePath: string }): void {
  if (input.source !== 'news' && input.source !== 'polymarket') throw new Error('Unsupported Research source')
  const { DatabaseSync } = createRequire(__filename)('node:sqlite') as {
    DatabaseSync: new (path: string, options?: { readOnly: boolean }) => OwnershipSqliteDatabase
  }
  const db = new DatabaseSync(resolve(input.databasePath), { readOnly: true })
  try {
    const authority = readSourceOwnership(db, input.source)
    if (!authority || authority.state !== 'paused') throw new Error('Research operator mutations require the named source to be durably paused')
  } finally { db.close() }
}
