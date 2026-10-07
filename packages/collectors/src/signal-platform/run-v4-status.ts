import { isAbsolute,resolve } from 'node:path'
import { loadDotenvChain } from '../pipeline-store/cli-env'
import { readManagedV4OperationalStatus, readV4OperationalStatus } from './v4-operational-status'
import { loadEntityManagerV4RuntimeConfig } from './runtime-config'

async function main():Promise<void>{
  loadDotenvChain()
  const packageDirectory=resolve(__dirname,'..','..')
  const path=(raw:string|undefined,fallback:string)=>{const configured=raw?.trim()||fallback;return isAbsolute(configured)?configured:resolve(packageDirectory,configured)}
  const config=loadEntityManagerV4RuntimeConfig()
  const status=readV4OperationalStatus({newsPath:path(process.env.NEWS_SQLITE_PATH,'.data/news.sqlite'),pipelinePath:path(process.env.PIPELINE_SQLITE_PATH,'.data/pipeline.sqlite'),now:new Date().toISOString()})
  const managed=await readManagedV4OperationalStatus()
  process.stdout.write(`${JSON.stringify({...status,managed,configuration:{managedWriterEnabled:config.managedWriterEnabled,noveltyEnabled:config.noveltyEnabled,researchReuseEnabled:config.researchReuseEnabled,followupEnabled:config.followupEnabled,sourceOwnershipEnabled:config.sourceOwnershipEnabled,activeSources:[...config.activeSources],policyVersion:config.policyVersion,assignmentPolicy:config.assignmentPolicy,synthesisPolicy:config.synthesisPolicy,reusePolicy:config.reusePolicy,followupPolicy:config.followupPolicy}},null,2)}\n`)
}

if(require.main===module)main().catch(()=>{process.stderr.write('[entity-v4-status] status unavailable\n');process.exitCode=1})
