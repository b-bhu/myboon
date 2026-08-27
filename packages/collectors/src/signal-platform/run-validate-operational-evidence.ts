import { loadDotenvChain } from '../pipeline-store/cli-env'
import { formatOperationalEvidenceJson, readOperationalEvidence } from './operational-evidence'

loadDotenvChain()

function main(): void {
  const args = process.argv.slice(2)
  const kindIndex = args.indexOf('--kind')
  const inputIndex = args.indexOf('--input')
  const kind = args[kindIndex + 1]
  const inputPath = args[inputIndex + 1]
  if ((kind !== 'rollback' && kind !== 'live-soak' && kind !== 'provider-outage') || !inputPath || args.length !== 4) {
    throw new Error('Usage: --kind rollback|live-soak|provider-outage --input /absolute/evidence.json')
  }
  process.stdout.write(`${formatOperationalEvidenceJson(readOperationalEvidence({ kind, inputPath }))}\n`)
}

try { main() } catch (error) {
  process.stderr.write(`[feed-v3-validate-evidence] ${error instanceof Error ? error.message : 'unknown failure'}\n`)
  process.exitCode = 1
}
