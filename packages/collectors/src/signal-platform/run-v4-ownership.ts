import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { packageScriptArgs } from '../cli-args'
import { loadDotenvChain } from '../pipeline-store/cli-env'
import { SqliteSourceOwnershipOperator, type SourceOwnershipReceipt } from './source-ownership'

export function parseV4OwnershipArgs(args:string[]) {
  let source:'news'|'polymarket'|undefined,receiptPath:string|undefined,operatorId:string|undefined,apply=false
  for(let index=0;index<args.length;index+=1){
    const key=args[index]
    if(key==='--apply'){if(apply)throw new Error('Duplicate --apply');apply=true;continue}
    const value=args[++index]
    if(!value?.trim()||value.startsWith('--'))throw new Error(`${key} requires a value`)
    if(key==='--source'){if(source||!['news','polymarket'].includes(value))throw new Error('Select one supported source');source=value as 'news'|'polymarket'}
    else if(key==='--receipt'){if(receiptPath)throw new Error('Duplicate --receipt');receiptPath=resolve(value)}
    else if(key==='--operator'){if(operatorId)throw new Error('Duplicate --operator');operatorId=value}
    else throw new Error(`Unknown ownership argument ${key}`)
  }
  if(!source||!receiptPath||!operatorId)throw new Error('--source, --receipt and --operator are required; preview is default')
  return {source,receiptPath,operatorId,apply}
}

function main():void {
  loadDotenvChain()
  const args=parseV4OwnershipArgs(packageScriptArgs(process.argv.slice(2)))
  const receipt=JSON.parse(readFileSync(args.receiptPath,'utf8')) as SourceOwnershipReceipt
  if(receipt.source!==args.source)throw new Error('Receipt source differs from explicit command source')
  const packageDirectory=resolve(__dirname,'..','..')
  const configured=(args.source==='news'?process.env.NEWS_SQLITE_PATH:process.env.PIPELINE_SQLITE_PATH)?.trim()||`.data/${args.source==='news'?'news':'pipeline'}.sqlite`
  const databasePath=isAbsolute(configured)?configured:resolve(packageDirectory,configured)
  const operator=new SqliteSourceOwnershipOperator(databasePath,!args.apply)
  try {
    const result=operator.run({receiptPath:args.receiptPath,operatorId:args.operatorId,apply:args.apply,now:new Date().toISOString()})
    process.stdout.write(`${JSON.stringify(result,null,2)}\n`)
  }finally{operator.close()}
}

if(require.main===module){try{main()}catch(error){process.stderr.write(`[entity-v4-ownership] ${error instanceof Error?error.message:'operation failed'}\n`);process.exitCode=1}}
