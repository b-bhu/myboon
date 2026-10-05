import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { CanonicalSourceSignalIntake } from './source-intake'
import { withSourceIntakeOwnership } from './source-intake-ownership'
import { createActiveSourceTriageIntake } from './active-triage'
import { SqliteLocalCapacitySnapshot } from './local-capacity'
import type { SqliteNewsStore } from '../news/sqlite-store'
import { installSourceOwnershipFences, readSourceOwnership, readSourceOwnershipObligations, sourceOwnershipAllows,
  SqliteSourceOwnershipOperator, withSourceOwnershipOperation } from './source-ownership'
import { operatorSignal, operatorWork } from './operator-fixtures.test-support'
import { operationsFixture, observationInput, withIsolatedV4Environment, OPERATIONS_NOW } from './v4-operations.test-support'

test('missing authority fails closed without creating a source database, including explicit operator apply',()=>{
  const restore=withIsolatedV4Environment(),fixture=operationsFixture()
  try{
    const missing=join(fixture.dir,'missing.sqlite')
    assert.equal(sourceOwnershipAllows({databasePath:missing,source:'news',domain:'research',owner:'shared'}),false)
    assert.throws(()=>new SqliteSourceOwnershipOperator(missing,false),/existing source database/)
    assert.equal(existsSync(missing),false)
    assert.equal(sourceOwnershipAllows({databasePath:fixture.path,source:'news',domain:'research',owner:'shared'}),false)
  }finally{fixture.dispose();restore()}
})

test('preview creates no authority, apply records exclusive ownership, stale environment cannot reopen legacy queues',()=>{
  const restore=withIsolatedV4Environment(),fixture=operationsFixture()
  try{
    const initialize=fixture.receipt('initialize')
    assert.equal(fixture.run(initialize,false).proposed.state,'paused')
    assert.equal(readSourceOwnership(fixture.db,'news'),null)
    fixture.run(initialize)
    const activation=fixture.receipt('resume_shared'),active=fixture.run(activation)
    assert.equal(active.proposed.state,'running')
    assert.deepEqual(active.proposed.owners,{collector:'shared',intake:'shared',research:'shared',entity:'shared'})
    process.env.ENTITY_V4_SOURCE_OWNERSHIP_ENABLED='0'
    assert.equal(sourceOwnershipAllows({databasePath:fixture.path,source:'news',domain:'research',owner:'legacy'}),false)
    assert.equal(sourceOwnershipAllows({databasePath:fixture.path,source:'news',domain:'research',owner:'shared'}),true)
    process.env.ENTITY_V4_SOURCE_OWNERSHIP_ENABLED='1'
    assert.equal(fixture.run(activation).replayed,true)
    assert.equal(readSourceOwnership(fixture.db,'news')?.revision,2)
    fixture.store.appendSignal(operatorSignal('news','shared'))
    assert.equal(fixture.store.admitResearchWork(operatorWork('news','shared')).inserted,true)
  }finally{fixture.dispose();restore()}
})

test('source receipts reject changed artifacts, changed policy, wrong revision, and mismatched executed receipt',()=>{
  const restore=withIsolatedV4Environment(),fixture=operationsFixture()
  try{
    const changed=fixture.receipt('initialize')
    writeFileSync(join(fixture.dir,changed.receipt.artifacts.health.path),'{}')
    assert.throws(()=>fixture.run(changed),/artifact changed/)
    assert.throws(()=>fixture.run(fixture.receipt('initialize',{expiresAt:'2026-10-03T08:59:30.000Z'}),false),/approval is expired/)
    const policy=fixture.receipt('initialize')
    process.env.ENTITY_V4_ACTIVE_SOURCES='news'
    assert.throws(()=>fixture.run(policy),/current runtime configuration/)
    delete process.env.ENTITY_V4_ACTIVE_SOURCES
    fixture.run(fixture.receipt('initialize'))
    const stale=fixture.receipt('resume_shared')
    fixture.run(fixture.receipt('pause'))
    assert.throws(()=>fixture.run(stale),/revision changed/)
    const mismatch=fixture.receipt('resume_shared',{expectedReceiptId:'another-executed-receipt'})
    assert.throws(()=>fixture.run(mismatch),/current executed receipt/)
    assert.equal(readSourceOwnership(fixture.db,'news')?.state,'paused')
  }finally{fixture.dispose();restore()}
})

test('paused source preserves immutable News observations and outbox but fences legacy and shared work',async()=>{
  const restore=withIsolatedV4Environment(),fixture=operationsFixture()
  try{
    fixture.run(fixture.receipt('initialize'))
    const native=fixture.legacy as SqliteNewsStore,input=observationInput('paused'),observed=await native.insertCandidateObservations([input])
    assert.equal(observed[0].status,'observed_only')
    const delivery=await native.listPendingSourceDeliveries(10)
    assert.equal(delivery.length,1)
    assert.equal(delivery[0].signal.canonicalUrl,input.fingerprint.canonicalArticleUrl)
    assert.equal(delivery[0].signal.visibleSummary,input.candidate.summary)
    assert.deepEqual(await native.claimPendingCandidateObservations(10),[])
    assert.throws(()=>fixture.db.prepare("UPDATE news_candidate_observations SET status='pending_research' WHERE id=?").run(observed[0].id),/V4_SOURCE_OWNERSHIP_FENCED/)
    fixture.store.appendSignal(operatorSignal('news','fenced'))
    assert.throws(()=>fixture.store.admitResearchWork(operatorWork('news','fenced')),/V4_SOURCE_OWNERSHIP_FENCED/)
    const configured=createActiveSourceTriageIntake({store:fixture.store,capacity:new SqliteLocalCapacitySnapshot(fixture.store),providerHealth:'healthy'})
    const intake=withSourceIntakeOwnership({intake:configured,observationIntake:new CanonicalSourceSignalIntake({mode:'observe',store:fixture.store}),source:'news',databasePath:fixture.path})
    const retained=await intake.ingest(delivery[0].signal)
    assert.equal(retained.held,'source_ownership_fenced')
    assert.equal(retained.workInserted,false)
    assert.ok(fixture.store.getSignal(delivery[0].signalId))
  }finally{fixture.dispose();restore()}
})

test('collector activity remains allowed while paused and blocks ownership activation until actually finished',async()=>{
  const restore=withIsolatedV4Environment(),fixture=operationsFixture()
  let finish!:()=>void
  try{
    fixture.run(fixture.receipt('initialize'))
    let entered!:()=>void
    const enteredPromise=new Promise<void>((resolve)=>{entered=resolve}),pending=new Promise<void>((resolve)=>{finish=resolve})
    const activity=withSourceOwnershipOperation({databasePath:fixture.path,source:'news',domain:'collector',owner:'legacy',observationsOnly:true},async()=>{entered();await pending})
    await enteredPromise
    assert.equal(readSourceOwnershipObligations(fixture.db,'news').trackedInflightOperations,1)
    assert.throws(()=>fixture.run(fixture.receipt('resume_shared')),/zero in-flight/)
    finish();await activity
    assert.equal(readSourceOwnershipObligations(fixture.db,'news').trackedInflightOperations,0)
    fixture.run(fixture.receipt('resume_shared'))
    await assert.rejects(()=>withSourceOwnershipOperation({databasePath:fixture.path,source:'news',domain:'entity',owner:'legacy'},async()=>assert.fail('legacy Entity must never run')),/fences operation start/)
  }finally{finish?.();fixture.dispose();restore()}
})

test('native and shared Research/Entity claims remain fenced across pauses and in-flight leases block rollback',async()=>{
  const restore=withIsolatedV4Environment(),fixture=operationsFixture()
  try{
    process.env.ENTITY_V4_SOURCE_OWNERSHIP_ENABLED='0'
    const native=fixture.legacy as SqliteNewsStore,[historical]=await native.insertCandidateObservations([observationInput('legacy-pending')])
    for(const id of ['research-claim','entity-claim']){
      fixture.store.appendSignal(operatorSignal('news',id))
      fixture.store.admitResearchWork(operatorWork('news',id,{status:id==='entity-claim'?'entity_pending':'research_pending',createdAt:OPERATIONS_NOW,updatedAt:OPERATIONS_NOW,freshnessDeadline:'2026-10-03T10:00:00.000Z'}))
    }
    process.env.ENTITY_V4_SOURCE_OWNERSHIP_ENABLED='1'
    fixture.run(fixture.receipt('initialize'))
    const research={workId:'work-research-claim',expectedStatus:'research_pending' as const,leaseOwner:'fixture-research',leaseId:'research-lease',leaseExpiresAt:'2026-10-03T09:05:00.000Z',now:OPERATIONS_NOW}
    const entity={workId:'work-entity-claim',expectedStatus:'entity_pending' as const,leaseOwner:'fixture-entity',leaseId:'entity-lease',leaseExpiresAt:'2026-10-03T09:05:00.000Z',now:OPERATIONS_NOW}
    await assert.rejects(()=>native.claimPendingCandidateObservations(1),/V4_SOURCE_OWNERSHIP_FENCED/)
    await assert.rejects(()=>fixture.store.claimWithLease(research),/V4_SOURCE_OWNERSHIP_FENCED/)
    await assert.rejects(()=>fixture.store.claimWithLease(entity),/V4_SOURCE_OWNERSHIP_FENCED/)
    assert.equal((await native.fetchCandidateObservation(historical.id))?.status,'pending_research','obsolete claim leaves historical work intact')
    fixture.run(fixture.receipt('resume_shared'))
    assert.ok(await fixture.store.claimWithLease(research));assert.ok(await fixture.store.claimWithLease(entity))
    await assert.rejects(()=>native.claimPendingCandidateObservations(1),/V4_SOURCE_OWNERSHIP_FENCED/)
    fixture.run(fixture.receipt('pause'))
    assert.equal(readSourceOwnershipObligations(fixture.db,'news').sharedLeases,2)
    assert.throws(()=>fixture.run(fixture.receipt('resume_legacy')),/zero in-flight/)
    assert.equal(await fixture.store.releaseLease({...research,expectedStatus:'retrieval_leased',targetStatus:'research_pending'}),true)
    assert.equal(await fixture.store.releaseLease({...entity,expectedStatus:'entity_leased',targetStatus:'entity_pending'}),true)
    await assert.rejects(()=>fixture.store.claimWithLease(research),/V4_SOURCE_OWNERSHIP_FENCED/)
    await assert.rejects(()=>fixture.store.claimWithLease(entity),/V4_SOURCE_OWNERSHIP_FENCED/)
    fixture.run(fixture.receipt('resume_legacy'))
    assert.equal((await native.claimPendingCandidateObservations(1))[0].id,historical.id)
    await assert.rejects(()=>fixture.store.claimWithLease(research),/V4_SOURCE_OWNERSHIP_FENCED/)
    assert.equal(readSourceOwnershipObligations(fixture.db,'news').legacyResearchInflight,1)
  }finally{fixture.dispose();restore()}
})

test('failed tracked work is settled, exact abandoned operations reconcile without queue replay, held payments prevent reopening',async()=>{
  const restore=withIsolatedV4Environment(),fixture=operationsFixture()
  try{
    fixture.run(fixture.receipt('initialize'))
    fixture.run(fixture.receipt('resume_legacy'))
    await assert.rejects(()=>withSourceOwnershipOperation({databasePath:fixture.path,source:'news',domain:'entity',owner:'legacy'},async()=>{throw new Error('fixture failure')}),/fixture failure/)
    assert.equal(readSourceOwnershipObligations(fixture.db,'news').trackedInflightOperations,0)
    fixture.run(fixture.receipt('pause'))
    fixture.db.prepare("INSERT INTO entity_v4_source_operations(operation_id,source_type,domain,owner,ownership_revision,state,started_at) VALUES ('abandoned','news','entity','legacy',3,'inflight',?)").run(OPERATIONS_NOW)
    assert.throws(()=>fixture.run(fixture.receipt('reconcile_abandoned',{abandonedOperationIds:['unknown-operation']}),false),/does not belong to this source/)
    assert.throws(()=>fixture.run(fixture.receipt('resume_shared')),/zero in-flight/)
    fixture.run(fixture.receipt('reconcile_abandoned',{abandonedOperationIds:['abandoned']}))
    assert.equal(readSourceOwnershipObligations(fixture.db,'news').trackedInflightOperations,0)
    const reservation={rootAssignmentId:'work-held',allowanceId:'followup',attemptId:'held',state:'execution_outcome_unknown' as const,
      requestDigest:'request-held',providerRoute:'fixture-only',approvedLimits:{maxProviderCalls:1,maxInputTokens:100,maxOutputTokens:20,maxIncrementalCostUsdMicros:null},
      reservationStatus:'reserved_max_exposure' as const,ownershipEpoch:1,noDispatchFact:null,settlement:null,createdAtMs:1,updatedAtMs:1}
    assert.equal(await fixture.store.researchBudgetStore().insert(reservation),'created')
    assert.equal(readSourceOwnershipObligations(fixture.db,'news').unknownPaidOutcomes,1)
    assert.throws(()=>fixture.run(fixture.receipt('resume_shared')),/unknown-payment/)
    assert.equal(fixture.store.listResearchReservations(10)[0].state,'execution_outcome_unknown')
  }finally{fixture.dispose();restore()}
})

test('Polymarket cannot activate ahead of News and requires its current executed shared receipt',()=>{
  const restore=withIsolatedV4Environment(),news=operationsFixture(),poly=operationsFixture('polymarket')
  try{
    poly.run(poly.receipt('initialize'))
    assert.throws(()=>poly.run(poly.receipt('resume_shared')),/Executed News ownership evidence/)
    news.run(news.receipt('initialize'))
    const activation=news.receipt('resume_shared'),executed=news.run(activation)
    const binding={databasePath:news.path,receiptId:activation.receipt.receiptId,receiptSha256:executed.evidenceSha256}
    poly.run(poly.receipt('resume_shared',{newsReceipt:binding}))
    assert.equal(sourceOwnershipAllows({databasePath:poly.path,source:'polymarket',domain:'research',owner:'shared'}),true)
    assert.equal(sourceOwnershipAllows({databasePath:poly.path,source:'polymarket',domain:'research',owner:'legacy'}),false)
    poly.run(poly.receipt('pause'))
    news.run(news.receipt('pause'))
    assert.throws(()=>poly.run(poly.receipt('resume_shared',{newsReceipt:binding})),/News ownership evidence is stale/)
  }finally{poly.dispose();news.dispose();restore()}
})

test('real native Polymarket fences permit completion/lease cleanup, deny obsolete claims and repair old trigger definitions without row writes',()=>{
  const restore=withIsolatedV4Environment(),news=operationsFixture(),poly=operationsFixture('polymarket')
  try{
    const insertCandidate=(id:string,status:string)=>poly.db.prepare(`INSERT INTO pipeline_candidates
      (id,source,area,candidate_type,market_id,slug,title,tag_slug,observed_at,what_changed,why_flagged,status,dedupe_key,lease_owner,lease_expires_at)
      VALUES (?,'polymarket','markets','odds_spike','fixture-market',?,'Fixture market','markets',?,'Odds moved','Material change',?,?,?,?)`).run(
        id,id,OPERATIONS_NOW,status,id,status==='researching'?'old-worker':null,status==='researching'?'2026-10-03T08:00:00.000Z':null,
      )
    insertCandidate('old-research','researching');insertCandidate('old-pending','pending_research')
    poly.db.prepare(`INSERT INTO pipeline_research
      (id,candidate_id,source,area,slug,title,candidate_type,research_mode,summary,notes,uncertainty,editor_notes,researched_at,research_family_key,research_cluster_key,research_depth,entity_manager_status,entity_manager_lease_owner,entity_manager_lease_expires_at)
      VALUES ('old-entity','old-research','polymarket','markets','fixture','Fixture','odds_spike','market_structure_only','Retained summary','Retained notes','Uncertain','Retained editor notes',?,'family','cluster','market_structure_only','processing','old-worker','2026-10-03T08:00:00.000Z')`).run(OPERATIONS_NOW)
    poly.run(poly.receipt('initialize'))
    assert.throws(()=>poly.db.prepare("UPDATE pipeline_candidates SET lease_expires_at='2026-10-03T10:00:00.000Z' WHERE id='old-research'").run(),/V4_SOURCE_OWNERSHIP_FENCED/)
    assert.throws(()=>poly.db.prepare("UPDATE pipeline_research SET entity_manager_lease_owner='obsolete-worker' WHERE id='old-entity'").run(),/V4_SOURCE_OWNERSHIP_FENCED/)
    // Releasing an already-held native lease is cleanup, without authorizing new work.
    poly.db.prepare("UPDATE pipeline_candidates SET lease_owner=NULL,lease_expires_at=NULL WHERE id='old-research'").run()
    poly.db.prepare("UPDATE pipeline_research SET entity_manager_lease_owner=NULL,entity_manager_lease_expires_at=NULL WHERE id='old-entity'").run()
    poly.db.prepare("UPDATE pipeline_candidates SET status='researched' WHERE id='old-research'").run()
    poly.db.prepare("UPDATE pipeline_research SET entity_manager_status='processed' WHERE id='old-entity'").run()
    news.run(news.receipt('initialize'))
    const newsReceipt=news.receipt('resume_shared'),newsResult=news.run(newsReceipt)
    poly.run(poly.receipt('resume_shared',{newsReceipt:{databasePath:news.path,receiptId:newsReceipt.receipt.receiptId,receiptSha256:newsResult.evidenceSha256}}))
    const triggerDefinitions=()=>poly.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'v4_polymarket_%' ORDER BY name").all()
    const originalTriggers=triggerDefinitions()
    const failingDatabase={
      exec:poly.db.exec.bind(poly.db),close:()=>{},
      prepare:(sql:string)=>{
        if(sql==='PRAGMA table_info(pipeline_research)')throw new Error('simulated native schema inspection failure')
        return poly.db.prepare(sql)
      },
    }
    assert.throws(()=>installSourceOwnershipFences(failingDatabase,'polymarket'),/simulated native schema inspection failure/)
    assert.deepEqual(triggerDefinitions(),originalTriggers,'standalone replacement failure must restore every prior fence')
    poly.db.exec('BEGIN IMMEDIATE')
    poly.db.prepare("UPDATE pipeline_candidates SET title='outer transaction write' WHERE id='old-pending'").run()
    assert.throws(()=>installSourceOwnershipFences(failingDatabase,'polymarket'),/simulated native schema inspection failure/)
    assert.deepEqual(triggerDefinitions(),originalTriggers)
    assert.equal((poly.db.prepare("SELECT title FROM pipeline_candidates WHERE id='old-pending'").get() as {title:string}).title,'outer transaction write')
    poly.db.exec('ROLLBACK')
    const snapshot=()=>({
      candidates:poly.db.prepare('SELECT * FROM pipeline_candidates ORDER BY id').all(),
      research:poly.db.prepare('SELECT * FROM pipeline_research ORDER BY id').all(),
      authority:readSourceOwnership(poly.db,'polymarket'),
    })
    const before=snapshot()
    // Reproduce the installed defect on actual native tables, then repair atomically.
    poly.db.exec(`DROP TRIGGER v4_polymarket_legacy_claim;
      CREATE TRIGGER v4_polymarket_legacy_claim BEFORE UPDATE OF status,lease_id ON pipeline_candidates
      WHEN NEW.status='researching' AND NEW.lease_id IS NOT OLD.lease_id BEGIN SELECT RAISE(ABORT,'V4_SOURCE_OWNERSHIP_FENCED'); END;
      DROP TRIGGER v4_polymarket_legacy_entity_claim;
      CREATE TRIGGER v4_polymarket_legacy_entity_claim BEFORE UPDATE OF entity_manager_status,entity_manager_lease_id ON pipeline_research
      WHEN NEW.entity_manager_status='processing' AND NEW.entity_manager_lease_id IS NOT OLD.entity_manager_lease_id BEGIN SELECT RAISE(ABORT,'V4_SOURCE_OWNERSHIP_FENCED'); END;`)
    assert.throws(()=>poly.db.prepare("EXPLAIN UPDATE pipeline_candidates SET status='researched' WHERE 0").all(),/NEW.lease_id/)
    assert.throws(()=>poly.db.prepare("EXPLAIN UPDATE pipeline_research SET entity_manager_status='processed' WHERE 0").all(),/NEW.entity_manager_lease_id/)
    poly.db.exec('BEGIN IMMEDIATE')
    try{installSourceOwnershipFences(poly.db,'polymarket');assert.deepEqual(snapshot(),before);poly.db.exec('COMMIT')}
    catch(error){poly.db.exec('ROLLBACK');throw error}
    assert.ok(poly.db.prepare("EXPLAIN UPDATE pipeline_candidates SET status='researched' WHERE 0").all().length>0)
    assert.ok(poly.db.prepare("EXPLAIN UPDATE pipeline_research SET entity_manager_status='processed' WHERE 0").all().length>0)
    assert.throws(()=>poly.db.prepare("UPDATE pipeline_candidates SET status='researching',lease_owner='obsolete',lease_expires_at='2026-10-03T10:00:00.000Z' WHERE id='old-pending'").run(),/V4_SOURCE_OWNERSHIP_FENCED/)
    assert.throws(()=>poly.db.prepare("UPDATE pipeline_research SET entity_manager_status='processing' WHERE id='old-entity'").run(),/V4_SOURCE_OWNERSHIP_FENCED/)
    assert.throws(()=>insertCandidate('obsolete-new','pending_research'),/V4_SOURCE_OWNERSHIP_FENCED/)
    assert.deepEqual(snapshot(),before)
    poly.store.appendSignal(operatorSignal('polymarket','shared-after-repair'))
    assert.equal(poly.store.admitResearchWork(operatorWork('polymarket','shared-after-repair')).inserted,true)
    assert.deepEqual(poly.db.prepare('PRAGMA foreign_key_check').all(),[])
  }finally{poly.dispose();news.dispose();restore()}
})

test('retirement requires stopped-worker and healthy-window evidence; rollback restores legacy authority without deleting history',async()=>{
  const restore=withIsolatedV4Environment(),fixture=operationsFixture()
  try{
    fixture.run(fixture.receipt('initialize'));fixture.run(fixture.receipt('resume_shared'))
    fixture.store.appendSignal(operatorSignal('news','history'))
    const incomplete=fixture.receipt('retire_legacy'),file=join(fixture.dir,incomplete.receipt.artifacts.health.path)
    const health=JSON.parse(readFileSync(file,'utf8')) as Record<string,unknown>
    health.workersStopped=false
    const bytes=JSON.stringify(health);writeFileSync(file,bytes)
    incomplete.receipt.artifacts.health.sha256=createHash('sha256').update(bytes).digest('hex')
    writeFileSync(incomplete.receiptPath,JSON.stringify(incomplete.receipt))
    assert.throws(()=>fixture.run(incomplete),/stopped source workers/)
    fixture.run(fixture.receipt('retire_legacy'))
    assert.equal(readSourceOwnership(fixture.db,'news')?.legacyRetired,true)
    fixture.run(fixture.receipt('pause'));fixture.run(fixture.receipt('resume_legacy'))
    assert.equal(readSourceOwnership(fixture.db,'news')?.legacyRetired,false)
    assert.equal(sourceOwnershipAllows({databasePath:fixture.path,source:'news',domain:'entity',owner:'legacy'}),true)
    assert.equal(sourceOwnershipAllows({databasePath:fixture.path,source:'news',domain:'entity',owner:'shared'}),false)
    assert.ok(fixture.store.getSignal('signal-history'))
    assert.equal((fixture.db.prepare('SELECT COUNT(*) AS n FROM entity_v4_source_ownership_receipts').get() as {n:number}).n,5)
  }finally{fixture.dispose();restore()}
})

test('intake checks ownership again after asynchronous capacity lookup and does not spend classifier or admit work',async()=>{
  const restore=withIsolatedV4Environment(),fixture=operationsFixture()
  try{
    fixture.run(fixture.receipt('initialize'));fixture.run(fixture.receipt('resume_shared'))
    let classifications=0
    const intake=createActiveSourceTriageIntake({store:fixture.store,providerHealth:'healthy',classifierEnabled:true,
      classifier:{async classify(){classifications+=1;throw new Error('must not be called')}},
      capacity:{async snapshot(input){fixture.run(fixture.receipt('pause'));return new SqliteLocalCapacitySnapshot(fixture.store).snapshot(input)}},
      mayAdmit:()=>sourceOwnershipAllows({databasePath:fixture.path,source:'news',domain:'intake',owner:'shared'}),
    })
    const signal=operatorSignal('news','changed-midcycle')
    await assert.rejects(()=>intake.ingest(signal),/fences triage execution/)
    assert.equal(classifications,0)
    assert.ok(fixture.store.getSignal(signal.signalId))
    assert.equal((fixture.db.prepare('SELECT COUNT(*) AS n FROM signal_platform_research_work').get() as {n:number}).n,0)
  }finally{fixture.dispose();restore()}
})
