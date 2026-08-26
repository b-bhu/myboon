import { createClient } from '@supabase/supabase-js'
import { loadDotenvChain } from '../pipeline-store/cli-env'
import { verifyEntityMemoryMigration } from './entity-memory-migration-verifier'

async function main(): Promise<void> {
  loadDotenvChain()
  const url = required('SUPABASE_URL')
  const serviceRoleKey = required('SUPABASE_SERVICE_ROLE_KEY')
  const report = await verifyEntityMemoryMigration(createClient(url, serviceRoleKey))
  process.stdout.write(`${JSON.stringify(report)}\n`)
  if (!report.ok) process.exitCode = 1
}

function required(field: string): string {
  const value = process.env[field]?.trim()
  if (!value) throw new Error(`Missing required env var: ${field}`)
  return value
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[entity-memory-migration-verifier] ${
      error instanceof Error ? error.message : 'unknown failure'
    }\n`)
    process.exitCode = 1
  })
}
