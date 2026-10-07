import { loadDotenvChain } from '../pipeline-store/cli-env'
import { assessRetainedPartialResearch } from './retained-partial-assessment'
import { openResearchOperatorStore, researchOperatorArguments, requirePausedResearchSource } from './research-operator-cli'

export function runRetainedPartialAssessment(args: readonly string[] = process.argv.slice(2)): unknown {
  const options = researchOperatorArguments(args, ['source', 'database', 'packet', 'admission', 'operator'])
  for (const key of ['source', 'database', 'packet', 'admission', 'operator']) if (!options[key]?.trim()) throw new Error(`--${key} is required`)
  requirePausedResearchSource({ source: options.source, databasePath: options.database })
  const store = openResearchOperatorStore({ source: options.source, databasePath: options.database })
  try {
    return assessRetainedPartialResearch({
      store, packetIds: [options.packet], admissionId: options.admission, operatorId: options.operator,
      limit: 1, now: new Date().toISOString(),
    })
  } finally { store.close() }
}

if (require.main === module) {
  loadDotenvChain()
  try { console.log(JSON.stringify(runRetainedPartialAssessment(), null, 2)) }
  catch (error) { console.error(error instanceof Error ? error.message : 'Research partial assessment failed'); process.exitCode = 1 }
}
