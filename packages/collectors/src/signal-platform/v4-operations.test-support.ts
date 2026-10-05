import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteNewsStore } from '../news/sqlite-store'
import { SqlitePipelineStore } from '../pipeline-store/sqlite-store'
import { fingerprintNewsCandidate } from '../news/fingerprint'
import type { NewsCandidateObservationInput } from '../news/store'
import { SqliteSignalPlatformStore } from './sqlite-platform-store'
import { readSourceOwnership, sourceOwnershipConfigurationDigest, SqliteSourceOwnershipOperator,
  type OwnershipSqliteDatabase, type SourceOwnershipReceipt, type SourceOwnershipAction } from './source-ownership'
import { sqliteStoreId } from './sqlite-write-error-journal'
import type { EntityManagerV4Source } from './runtime-config'

export const {DatabaseSync}=createRequire(__filename)('node:sqlite') as {
  DatabaseSync:new(path:string,options?:{readOnly?:boolean})=>OwnershipSqliteDatabase
}

export const OPERATIONS_NOW='2026-10-03T09:00:00.000Z'
export const OPERATIONS_OPERATOR='isolated-rehearsal-operator'

export function observationInput(id='fixture'):NewsCandidateObservationInput {
  const source={sourceId:'fixture-news-source',sourceName:'Fixture source',sourceType:'curated_news' as const}
  const sourceUrl={urlId:'fixture-feed',label:'Fixture feed',url:'https://example.com/feed'}
  const candidate={headline:`Regulator filing ${id}`,article_url:`https://example.com/${id}`,summary:'The source alleges a policy violation.'}
  return {source,sourceUrl,candidate,fingerprint:fingerprintNewsCandidate(source.sourceId,sourceUrl.urlId,candidate),dedupeOutcome:'new_candidate',observedAt:OPERATIONS_NOW}
}

export function withIsolatedV4Environment():()=>void {
  const names=Object.keys(process.env).filter((name)=>name.startsWith('ENTITY_V4_')||name.startsWith('MYBOON_MANAGED_KNOWLEDGE_'))
  const previous=new Map(names.map((name)=>[name,process.env[name]]))
  for(const name of names)delete process.env[name]
  process.env.ENTITY_V4_SOURCE_OWNERSHIP_ENABLED='1'
  return ()=>{
    for(const name of Object.keys(process.env))if(name.startsWith('ENTITY_V4_')||name.startsWith('MYBOON_MANAGED_KNOWLEDGE_'))delete process.env[name]
    for(const [name,value]of previous)if(value!==undefined)process.env[name]=value
  }
}

export function operationsFixture(source:EntityManagerV4Source='news') {
  const dir=mkdtempSync(join(tmpdir(),'myboon-v4-operations-'))
  const path=join(dir,source==='news'?'news.sqlite':'pipeline.sqlite')
  const legacy=source==='news'?new SqliteNewsStore(path):new SqlitePipelineStore(path)
  const store=new SqliteSignalPlatformStore(path,source)
  const db=new DatabaseSync(path)
  db.exec('PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;')
  let nextReceipt=0
  const receipt=(action:SourceOwnershipAction,extra:Partial<SourceOwnershipReceipt>={})=>{
    const current=readSourceOwnership(db,source)
    const id=`fixture-${source}-${++nextReceipt}-${action}`
    const ownership:SourceOwnershipReceipt={
      schemaVersion:'myboon.entity_v4_source_ownership_receipt.v1',receiptId:id,source,storeId:sqliteStoreId(path),action,
      expectedRevision:current?.revision??0,expectedReceiptId:current?.lastReceiptId??null,
      approvedBy:OPERATIONS_OPERATOR,approvedAt:'2026-10-03T08:59:00.000Z',expiresAt:'2026-10-03T10:00:00.000Z',artifacts:{} as SourceOwnershipReceipt['artifacts'],...extra,
    }
    for(const kind of ['backup_restore','evaluation','health','allowance','reconciliation'] as const){
      const artifact={schemaVersion:'myboon.entity_v4_ownership_evidence.v1',kind,source,storeId:sqliteStoreId(path),passed:true,
        reviewedBy:OPERATIONS_OPERATOR,observedAt:'2026-10-03T08:58:00.000Z',
        ownershipRevision:ownership.expectedRevision,ownershipReceiptId:ownership.expectedReceiptId,
        backupVerified:true,restoreVerified:true,policyVersion:'fixture-explicit-policy',configSha256:sourceOwnershipConfigurationDigest(),
        workersStopped:true,canonicalPathHealthy:true,observationStartedAt:'2026-10-03T08:00:00.000Z',requiredHealthyWindowMs:30*60_000,
        inflightReconciled:true,outboxReconciled:true,residualReferencesAccounted:true,managedLeasesReconciled:true,managedPlanningDispatchesReconciled:true,
      }
      const fileName=`${id}-${kind}.json`,bytes=JSON.stringify(artifact)
      writeFileSync(join(dir,fileName),bytes)
      ownership.artifacts[kind]={path:fileName,sha256:createHash('sha256').update(bytes).digest('hex')}
    }
    const receiptPath=join(dir,`${id}.json`)
    writeFileSync(receiptPath,JSON.stringify(ownership))
    return {receipt:ownership,receiptPath}
  }
  const run=(prepared:ReturnType<typeof receipt>,apply=true)=>{
    const operator=new SqliteSourceOwnershipOperator(path,!apply)
    try{return operator.run({receiptPath:prepared.receiptPath,operatorId:OPERATIONS_OPERATOR,now:OPERATIONS_NOW,apply})}finally{operator.close()}
  }
  return {dir,path,source,legacy,store,db,receipt,run,dispose(){for(const resource of [db,store,legacy]){try{resource.close()}catch{/* fixture may explicitly close an old connection during upgrade */}}rmSync(dir,{recursive:true,force:true})}}
}
