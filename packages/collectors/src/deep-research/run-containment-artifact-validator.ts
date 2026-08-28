import { packageScriptArgs } from '../cli-args'
import {
  parseDeepContainmentArtifactValidationArgs,
  validateDeepContainmentArtifact,
} from './containment-artifact-validator'

validateDeepContainmentArtifact(
  parseDeepContainmentArtifactValidationArgs(packageScriptArgs(process.argv.slice(2))),
).then((report) => {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (!report.passed) process.exitCode = 2
}).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Deep containment artifact validation failed'}\n`)
  process.exitCode = 1
})
