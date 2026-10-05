import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync,readFileSync,writeFileSync } from 'node:fs'
import { join,resolve } from 'node:path'
import test from 'node:test'
import type { D2ReservationRecord } from '../research-engine/assignment-budget'
import { readV4OperationalStatus,readV4SourceOperationalStatus } from './v4-operational-status'
import { SqliteExecutionLedger } from './sqlite-execution-ledger'
import { operatorExecutionEvent,operatorSignal,operatorWork } from './operator-fixtures.test-support'
import { operationsFixture,withIsolatedV4Environment,OPERATIONS_NOW,OPERATIONS_OPERATOR } from './v4-operations.test-support'
import { parseV4OwnershipArgs } from './run-v4-ownership'
import { readSourceOwnership } from './source-ownership'

test('operational metrics expose durable unknown holds, known versus unknown costs, actual reuse and execution counters',async()=>{
  const restore=withIsolatedV4Environment(),fixture=operationsFixture()
  const ledger=new SqliteExecutionLedger(fixture.path)
  try{
    for(const id of ['reused','rejected','evidence']){fixture.store.appendSignal(operatorSignal('news',id));fixture.store.admitResearchWork(operatorWork('news',id))}
    fixture.run(fixture.receipt('initialize'))
    const base:D2ReservationRecord={rootAssignmentId:'root',allowanceId:'fixture',attemptId:'fixture',state:'settled',requestDigest:'fixture-request',providerRoute:'fixture-provider',
      approvedLimits:{maxProviderCalls:1,maxInputTokens:100,maxOutputTokens:20,maxIncrementalCostUsdMicros:null},reservationStatus:'settled_actual_or_unknown_usage',ownershipEpoch:2,noDispatchFact:null,
      settlement:{attemptId:'fixture',requestDigest:'fixture-request',providerResultDigest:'saved-result-digest',savedResultRef:'saved-result',usage:{status:'measured',costUsdMicros:123,inputTokens:50,outputTokens:10,providerCalls:1},settledByEpoch:2,settledAtMs:2},createdAtMs:1,updatedAtMs:2}
    const known={...base,rootAssignmentId:'root-known'}
    const unknown={...base,rootAssignmentId:'root-unknown',settlement:{...base.settlement!,usage:{status:'unknown' as const,costUsdMicros:null,inputTokens:null,outputTokens:null}}}
    const held={...base,rootAssignmentId:'root-held',state:'execution_outcome_unknown' as const,reservationStatus:'reserved_max_exposure' as const,settlement:null}
    for(const record of [known,unknown,held])assert.equal(await fixture.store.researchBudgetStore().insert(record),'created')
    fixture.store.putResearchV4Record('research_reuse','work-reused','accepted',{decision:'reuse_result'})
    fixture.store.putResearchV4Record('research_reuse','work-rejected','rejected',{decision:'rejected'})
    fixture.store.putResearchV4Record('evidence_reuse','work-evidence','evidence',{capture:{evidenceId:'fixture-evidence'}})
    ledger.append(operatorExecutionEvent('news','known',{costUsdMicros:123}))
    ledger.append(operatorExecutionEvent('news','unknown'))
    const status=readV4SourceOperationalStatus({databasePath:fixture.path,source:'news'})
    assert.equal(status.availability,'available')
    assert.equal(status.ownership.value?.state,'paused')
    assert.deepEqual(status.reservations.value,{byState:{execution_outcome_unknown:1,settled:2},unknownOutcomeHolds:1,settledWithMeasuredCost:1,settledWithUnknownCost:1,measuredCostUsdMicros:123})
    assert.deepEqual(status.reuse.value,{evidenceReuses:1,researchReuses:1,rejectedResearchReuse:1})
    assert.deepEqual(status.providerUsage.value,{terminalEvents:2,providerCalls:2,inputTokens:200,outputTokens:80,repairCalls:0,measuredCostEvents:1,unmeasuredCostEvents:1,measuredCostUsdMicros:123,totalWallTimeMs:120000})
    assert.equal(status.obligations.value?.unknownPaidOutcomes,1)
  }finally{ledger.close();fixture.dispose();restore()}
})

test('missing or corrupt SQLite sources stay unavailable, retain healthy peer metrics, and never create files',()=>{
  const restore=withIsolatedV4Environment(),fixture=operationsFixture()
  try{
    const missing=join(fixture.dir,'missing.sqlite'),corrupt=join(fixture.dir,'corrupt.sqlite')
    writeFileSync(corrupt,'isolated corrupt fixture')
    for(const pipelinePath of [missing,corrupt]){
      const status=readV4OperationalStatus({newsPath:fixture.path,pipelinePath,now:OPERATIONS_NOW})
      assert.equal(status.sources.news.work.availability,'available')
      assert.equal(status.sources.polymarket.availability,'unavailable')
      assert.equal(status.sources.polymarket.reservations.value,null)
    }
    assert.equal(existsSync(missing),false)
  }finally{fixture.dispose();restore()}
})

test('new and existing status commands return compatible JSON on isolated paths with managed writer disabled',()=>{
  const restore=withIsolatedV4Environment(),fixture=operationsFixture()
  try{
    const env={...process.env,ENTITY_V4_MANAGED_WRITER_ENABLED:'0',ENTITY_V4_NOVELTY_ENABLED:'0',ENTITY_V4_RESEARCH_REUSE_ENABLED:'0',ENTITY_V4_FOLLOWUP_ENABLED:'0',
      NODE_APP_INSTANCE:undefined,NEWS_SQLITE_PATH:fixture.path,PIPELINE_SQLITE_PATH:join(fixture.dir,'missing-pipeline.sqlite'),
      FEED_V3_RESEARCH_RUNTIME_STATUS_PATH:join(fixture.dir,'missing-research.json'),FEED_V3_ENTITY_RUNTIME_STATUS_PATH:join(fixture.dir,'missing-entity.json'),FEED_V3_SQLITE_WRITE_ERROR_JOURNAL_PATH:join(fixture.dir,'missing-health.jsonl')}
    for(const script of ['run-v4-status.ts','run-status.ts']){
      const run=spawnSync(process.execPath,['--import',require.resolve('tsx'),resolve(__dirname,script)],{cwd:fixture.dir,env,encoding:'utf8',timeout:30000})
      assert.equal(run.status,0,`${script}: ${run.stderr}`)
      const json=JSON.parse(run.stdout) as Record<string,any>
      if(script==='run-v4-status.ts'){
        assert.equal(json.schemaVersion,'myboon.entity_v4_operational_status.v1');assert.equal(json.managed.availability,'disabled')
      }else{
        assert.equal(json.schemaVersion,'myboon.control_plane_status.v1');assert.equal(json.entityV4.sources.news.source,'news');assert.equal(json.entityV4.managed.availability,'disabled')
      }
      assert.equal(run.stdout.includes('MYBOON_MANAGED_KNOWLEDGE_DATABASE_URL'),false)
      assert.equal(existsSync(env.PIPELINE_SQLITE_PATH),false)
    }
  }finally{fixture.dispose();restore()}
})

test('ownership command requires exact source, operator and receipt and remains preview by default',()=>{
  const parsed=parseV4OwnershipArgs(['--source','news','--receipt','receipt.json','--operator','fixture-operator'])
  assert.equal(parsed.apply,false);assert.equal(parsed.source,'news')
  assert.throws(()=>parseV4OwnershipArgs(['--source','news','--apply']),/required/)
  assert.throws(()=>parseV4OwnershipArgs(['--source','x','--receipt','fixture','--operator','fixture']),/supported source/)
  assert.throws(()=>parseV4OwnershipArgs(['--source','news','--receipt','fixture','--operator','fixture','--apply','--apply']),/Duplicate --apply/)
})

test('actual ownership CLI previews without mutation then applies the bound receipt once on a disposable source',()=>{
  const restore=withIsolatedV4Environment(),fixture=operationsFixture()
  try{
    const prepared=fixture.receipt('initialize'),clock=Date.now()
    prepared.receipt.approvedAt=new Date(clock-60_000).toISOString()
    prepared.receipt.expiresAt=new Date(clock+60*60_000).toISOString()
    for(const binding of Object.values(prepared.receipt.artifacts)){
      const path=join(fixture.dir,binding.path),artifact=JSON.parse(readFileSync(path,'utf8')) as Record<string,unknown>
      artifact.observedAt=new Date(clock-120_000).toISOString()
      const bytes=JSON.stringify(artifact);writeFileSync(path,bytes)
      binding.sha256=createHash('sha256').update(bytes).digest('hex')
    }
    writeFileSync(prepared.receiptPath,JSON.stringify(prepared.receipt))
    const env={...process.env,NEWS_SQLITE_PATH:fixture.path,NODE_APP_INSTANCE:undefined}
    const args=['--import',require.resolve('tsx'),resolve(__dirname,'run-v4-ownership.ts'),'--source','news','--receipt',prepared.receiptPath,'--operator',OPERATIONS_OPERATOR]
    const preview=spawnSync(process.execPath,args,{cwd:fixture.dir,env,encoding:'utf8',timeout:30000})
    assert.equal(preview.status,0,preview.stderr)
    assert.equal((JSON.parse(preview.stdout) as {mode:string}).mode,'preview')
    assert.equal(readSourceOwnership(fixture.db,'news'),null)
    for(let run=0;run<2;run+=1){
      const applied=spawnSync(process.execPath,[...args,'--apply'],{cwd:fixture.dir,env,encoding:'utf8',timeout:30000})
      assert.equal(applied.status,0,applied.stderr)
      const result=JSON.parse(applied.stdout) as {mode:string;replayed:boolean}
      assert.equal(result.mode,'apply');assert.equal(result.replayed,run===1)
    }
    assert.equal(readSourceOwnership(fixture.db,'news')?.revision,1)
    assert.equal((fixture.db.prepare('SELECT COUNT(*) AS n FROM entity_v4_source_ownership_receipts').get() as {n:number}).n,1)
  }finally{fixture.dispose();restore()}
})
