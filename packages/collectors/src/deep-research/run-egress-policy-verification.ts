import { packageScriptArgs } from '../cli-args'
import {
  NodeSystemdEgressPolicyInspector,
  parseDeepResearchEgressPolicyVerificationArgs,
  verifyDeepResearchEgressPolicy,
} from './egress-policy-verification'

const command = parseDeepResearchEgressPolicyVerificationArgs(packageScriptArgs(process.argv.slice(2)))
verifyDeepResearchEgressPolicy({ ...command, inspector: new NodeSystemdEgressPolicyInspector() }).then((report) => {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (!report.passed) process.exitCode = 2
}).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Deep egress policy verification failed'}\n`)
  process.exitCode = 1
})
