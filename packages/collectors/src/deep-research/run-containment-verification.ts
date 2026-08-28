import { packageScriptArgs } from '../cli-args'
import {
  parseDeepContainmentVerificationArgs,
  runDeepContainmentVerification,
} from './containment-verification'

runDeepContainmentVerification(parseDeepContainmentVerificationArgs(packageScriptArgs(process.argv.slice(2)))).then((artifact) => {
  process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`)
  if (!artifact.passed) process.exitCode = 2
}).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Deep containment verification failed'}\n`)
  process.exitCode = 1
})
