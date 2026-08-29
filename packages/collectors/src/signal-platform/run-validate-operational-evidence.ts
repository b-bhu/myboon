import { packageScriptArgs } from '../cli-args'
import { loadDotenvChain } from '../pipeline-store/cli-env'
import { formatOperationalEvidenceJson } from './operational-evidence'
import { readOperationalEvidenceBundle } from './operational-evidence-bundle'

loadDotenvChain()

function main(): void {
  const args = packageScriptArgs(process.argv.slice(2))
  const kindIndex = args.indexOf('--kind')
  const inputIndex = args.indexOf('--input')
  const policyIndex = args.indexOf('--policy')
  const kind = args[kindIndex + 1]
  const inputPath = args[inputIndex + 1]
  const policyPath = args[policyIndex + 1]
  if ((kind !== 'rollback' && kind !== 'live-load' && kind !== 'live-soak' && kind !== 'provider-outage')
    || !inputPath || !policyPath || args.length !== 6) {
    throw new Error('Usage: --kind rollback|live-load|live-soak|provider-outage --input /absolute/evidence.json --policy /absolute/reviewed-policy.json')
  }
  const bundle = readOperationalEvidenceBundle({ kind, evidencePath: inputPath, policyPath })
  process.stdout.write(`${formatOperationalEvidenceJson(bundle.evidence)}\n`)
}

try { main() } catch (error) {
  process.stderr.write(`[feed-v3-validate-evidence] ${error instanceof Error ? error.message : 'unknown failure'}\n`)
  process.exitCode = 1
}
