import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { evaluateTriageDataset, parseTriageEvaluationArgs } from './triage-evaluation-command'

const MAX_DATASET_BYTES = 64 * 1024 * 1024

function main(): void {
  const command = parseTriageEvaluationArgs(process.argv.slice(2))
  const path = resolve(command.inputPath)
  const size = statSync(path).size
  if (size > MAX_DATASET_BYTES) throw new Error(`Evaluation dataset exceeds ${MAX_DATASET_BYTES} bytes`)
  const artifact = evaluateTriageDataset({ bytes: readFileSync(path, 'utf8'), thresholds: command.thresholds })
  process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`)
  if (!artifact.passed) process.exitCode = 2
}

try { main() } catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Evaluation failed'}\n`)
  process.exitCode = 1
}
