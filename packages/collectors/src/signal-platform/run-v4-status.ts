import { resolve } from 'node:path'
import { loadDotenvChain } from '../pipeline-store/cli-env'
import { resolveLaneSqlitePathFromEnv } from '../lane-store/paths'
import { readManagedV4OperationalStatus, readV4OperationalStatus } from './v4-operational-status'
import { loadEntityManagerV4RuntimeConfig } from './runtime-config'

async function main():Promise<void>{
  loadDotenvChain()
  const packageDirectory=resolve(__dirname,'..','..')
  const config=loadEntityManagerV4RuntimeConfig()
  const status=readV4OperationalStatus({newsPath:resolveLaneSqlitePathFromEnv('news',process.env,{baseDir:packageDirectory}),pipelinePath:resolveLaneSqlitePathFromEnv('polymarket',process.env,{baseDir:packageDirectory}),now:new Date().toISOString()})
  const managed=await readManagedV4OperationalStatus()
  process.stdout.write(`${JSON.stringify({...status,managed,configuration:{managedWriterEnabled:config.managedWriterEnabled,noveltyEnabled:config.noveltyEnabled,researchReuseEnabled:config.researchReuseEnabled,followupEnabled:config.followupEnabled,sourceOwnershipEnabled:config.sourceOwnershipEnabled,activeSources:[...config.activeSources],policyVersion:config.policyVersion,assignmentPolicy:config.assignmentPolicy,synthesisPolicy:config.synthesisPolicy,reusePolicy:config.reusePolicy,followupPolicy:config.followupPolicy}},null,2)}\n`)
}

if(require.main===module)main().catch(()=>{process.stderr.write('[entity-v4-status] status unavailable\n');process.exitCode=1})
