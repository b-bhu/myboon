import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { SqliteNewsStore } from '../news/sqlite-store'
import type { NewsResearchResponse } from '../news/types'
import { backupNewsStore,backupPipelineStore,verifyNewsBackup,verifyPipelineBackup,restoreNewsStore,restorePipelineStore } from '../pipeline-store/backup'
import { linkArtifact } from '../research-engine/artifact-repository'
import { operatorSignal,operatorWork,operatorEvidence,operatorPacket } from './operator-fixtures.test-support'
import { operationsFixture,observationInput,withIsolatedV4Environment,DatabaseSync,OPERATIONS_NOW } from './v4-operations.test-support'
import { SqliteSignalPlatformStore } from './sqlite-platform-store'
import { readSourceOwnership } from './source-ownership'

function response(candidate:import('../news/store').NewsCandidateObservationRow):NewsResearchResponse{return {
  schema_version:'myboon.hermes.research_response.v1',job_id:'history-research-job',candidate_id:candidate.id,source_id:candidate.sourceId,url_id:candidate.urlId,status:'ready_for_entity_memory',
  source_signal:{source_name:candidate.sourceName,source_url:candidate.sourceUrl,article_url:candidate.rawCandidate.article_url,canonical_article_url:candidate.canonicalArticleUrl,
    headline:candidate.headline,visible_summary:candidate.visibleSummary,published_at:candidate.publishedAt,observed_at:candidate.observedAt},
  research_summary:{one_liner:'A sourced allegation remains attributed.',what_was_checked:['Source filing'],requires_followup:false},
  article_claims:[{claim_id:'claim-history',claim:'The filing alleges a policy violation.'}],verified_facts:[],unresolved_claims:[],entity_hints:[],
  evidence:[{evidence_id:'history-evidence',title:'Filing',url:'https://example.com/history'}],open_questions:[],limitations:['Allegation is not independently verified.'],errors:[],
}}

test('old constrained News status upgrades preserve every historical row, child FK, custom index and trigger',async()=>{
  const restore=withIsolatedV4Environment(),fixture=operationsFixture()
  let upgraded:SqliteNewsStore|undefined
  try{
    process.env.ENTITY_V4_SOURCE_OWNERSHIP_ENABLED='0'
    const news=fixture.legacy as SqliteNewsStore,[candidate]=await news.insertCandidateObservations([observationInput('history')])
    const historicalResponse=response(candidate),historicalRawResponse='unaltered historical raw research'
    await news.insertResearchResult({candidate,response:historicalResponse,researchedAt:OPERATIONS_NOW})
    fixture.db.prepare('UPDATE news_candidate_observations SET research_raw_response=? WHERE id=?').run(historicalRawResponse,candidate.id)
    fixture.db.exec(`CREATE TABLE fixture_observation_audit(id TEXT);
      CREATE INDEX fixture_history_index ON news_candidate_observations(content_hash);
      CREATE TRIGGER fixture_history_trigger AFTER UPDATE OF headline ON news_candidate_observations BEGIN INSERT INTO fixture_observation_audit(id) VALUES(NEW.id); END;`)
    const candidateBefore=fixture.db.prepare('SELECT * FROM news_candidate_observations WHERE id=?').get(candidate.id)
    const researchBefore=fixture.db.prepare('SELECT * FROM news_research_results WHERE candidate_observation_id=?').get(candidate.id)
    news.close()
    const schema=fixture.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='news_candidate_observations'").get() as {sql:string}
    const historicalSchema=schema.sql.replace(/,\s*'observed_only'/,'')
    assert.notEqual(historicalSchema,schema.sql)
    const dependencies=fixture.db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='news_candidate_observations' AND type IN ('index','trigger') AND sql IS NOT NULL").all() as Array<{sql:string}>
    // Construct a genuine old CHECK constraint on disposable fixture data;
    // no writable_schema override or production connection is involved.
    fixture.db.exec('PRAGMA foreign_keys=OFF;BEGIN IMMEDIATE;')
    fixture.db.exec(historicalSchema.replace('news_candidate_observations','news_candidate_observations_legacy_fixture'))
    fixture.db.exec(`INSERT INTO news_candidate_observations_legacy_fixture SELECT * FROM news_candidate_observations;
      DROP TABLE news_candidate_observations;
      ALTER TABLE news_candidate_observations_legacy_fixture RENAME TO news_candidate_observations;`)
    for(const definition of dependencies)fixture.db.exec(definition.sql)
    fixture.db.exec('COMMIT;PRAGMA foreign_keys=ON;')
    const oldReader=new DatabaseSync(fixture.path)
    try{assert.throws(()=>oldReader.prepare("UPDATE news_candidate_observations SET status='observed_only' WHERE id=?").run(candidate.id),/CHECK constraint/)}finally{oldReader.close()}
    upgraded=new SqliteNewsStore(fixture.path)
    assert.deepEqual(fixture.db.prepare('SELECT * FROM news_candidate_observations WHERE id=?').get(candidate.id),candidateBefore)
    assert.deepEqual(fixture.db.prepare('SELECT * FROM news_research_results WHERE candidate_observation_id=?').get(candidate.id),researchBefore)
    assert.equal((await upgraded.fetchCandidateObservation(candidate.id))?.researchRawResponse,historicalRawResponse)
    assert.equal((researchBefore as {raw_response:string}).raw_response,JSON.stringify(historicalResponse))
    assert.deepEqual(fixture.db.prepare('PRAGMA foreign_key_check').all(),[])
    assert.deepEqual(fixture.db.prepare("SELECT name FROM sqlite_master WHERE name IN ('fixture_history_index','fixture_history_trigger') ORDER BY name").all().map(row=>(row as {name:string}).name),['fixture_history_index','fixture_history_trigger'])
    fixture.db.prepare("UPDATE news_candidate_observations SET headline='Retained trigger still executes' WHERE id=?").run(candidate.id)
    assert.deepEqual(fixture.db.prepare('SELECT id FROM fixture_observation_audit').all().map(row=>(row as {id:string}).id),[candidate.id])
    fixture.db.prepare("UPDATE news_candidate_observations SET status='observed_only' WHERE id=?").run(candidate.id)
    assert.equal((await upgraded.fetchCandidateObservation(candidate.id))?.status,'observed_only')
    assert.equal((await upgraded.listPendingSourceDeliveries(10)).length,0,'schema upgrade never fabricates historical delivery obligations')
  }finally{upgraded?.close();fixture.dispose();restore()}
})

test('real News and Polymarket backups restore producer pins, consumer usage, unknown reservations, root limits and executed ownership receipts',async()=>{
  const restore=withIsolatedV4Environment(),news=operationsFixture(),poly=operationsFixture('polymarket')
  let restoredNews:SqliteSignalPlatformStore|undefined,restoredPoly:SqliteSignalPlatformStore|undefined
  try{
    const hints={entities:['Fixture exchange'],assets:[],eventId:null,deadline:null}
    news.store.appendSignal(operatorSignal('news','producer',{sourceHints:hints}));news.store.admitResearchWork(operatorWork('news','producer',{createdAt:OPERATIONS_NOW,freshnessDeadline:'2026-10-03T10:00:00.000Z'}))
    poly.store.appendSignal(operatorSignal('polymarket','consumer',{sourceHints:hints}));poly.store.admitResearchWork(operatorWork('polymarket','consumer',{createdAt:OPERATIONS_NOW,freshnessDeadline:'2026-10-03T10:00:00.000Z'}))
    const evidence=operatorEvidence('producer',{retrievedAt:OPERATIONS_NOW})
    news.store.appendEvidence(evidence);news.store.appendResearchPacket(operatorPacket('news','producer',{createdAt:OPERATIONS_NOW}))
    const usage=linkArtifact({owner:news.store,consumer:poly.store,artifactId:evidence.evidenceId,consumerWorkId:'work-consumer',now:OPERATIONS_NOW})
    assert.equal(usage.decision,'background_only');assert.ok(usage.pinId)
    const reservation={rootAssignmentId:'work-producer',allowanceId:'primary',attemptId:'unknown-paid',state:'execution_outcome_unknown' as const,
      requestDigest:'fixture-request',providerRoute:'fixture-only',approvedLimits:{maxProviderCalls:1,maxInputTokens:100,maxOutputTokens:20,maxIncrementalCostUsdMicros:null},
      assignmentLimits:{policyVersion:'fixture-assignment-policy',maxProviderCalls:2,maxInputTokens:1000,maxOutputTokens:100,maxIncrementalCostUsdMicros:null},
      reservationStatus:'reserved_max_exposure' as const,ownershipEpoch:7,noDispatchFact:null,settlement:null,createdAtMs:1,updatedAtMs:2}
    assert.equal(await news.store.researchBudgetStore().insert(reservation),'created')
    news.store.putResearchV4Record('baseline','work-producer','baseline-producer',{providerDispatchKnown:true,limitations:['Unknown charge remains held.']})
    news.run(news.receipt('initialize'));poly.run(poly.receipt('initialize'))
    await (news.legacy as SqliteNewsStore).insertCandidateObservations([observationInput('owed-after-pause')])
    const newsBackup=await backupNewsStore({sourcePath:news.path,backupDir:join(news.dir,'backups'),now:OPERATIONS_NOW})
    const polyBackup=await backupPipelineStore({sourcePath:poly.path,backupDir:join(poly.dir,'backups'),now:OPERATIONS_NOW})
    assert.equal(newsBackup.manifest.schemaVersion,'myboon.sqlite_backup_manifest.v2')
    assert.equal(newsBackup.tableCounts.signal_platform_artifact_pins,1)
    assert.equal(polyBackup.tableCounts.signal_platform_artifact_usages,1)
    for(const table of ['signal_platform_research_reservations','signal_platform_research_assignment_limits','entity_v4_source_ownership','entity_v4_source_ownership_receipts','signal_platform_research_v4_records'])assert.equal(newsBackup.tableCounts[table],1,table)
    assert.equal((await verifyNewsBackup(newsBackup.path,newsBackup.sourceTableCounts)).ok,true)
    assert.equal((await verifyPipelineBackup(polyBackup.path,polyBackup.sourceTableCounts)).ok,true)
    const targetNews=join(news.dir,'restored-news.sqlite'),targetPoly=join(poly.dir,'restored-pipeline.sqlite')
    assert.equal((await restoreNewsStore({backupPath:newsBackup.path,targetPath:targetNews})).verified,true)
    assert.equal((await restorePipelineStore({backupPath:polyBackup.path,targetPath:targetPoly})).verified,true)
    restoredNews=new SqliteSignalPlatformStore(targetNews,'news');restoredPoly=new SqliteSignalPlatformStore(targetPoly,'polymarket')
    assert.equal(restoredNews.artifactStoreId(),news.store.artifactStoreId())
    assert.equal(restoredPoly.artifactStoreId(),poly.store.artifactStoreId())
    const pin=restoredNews.getArtifactPin(usage.pinId!)
    assert.ok(pin);assert.deepEqual(restoredNews.resolvePinnedArtifact(pin),evidence)
    assert.deepEqual(restoredPoly.listArtifactUsagesByWork('work-consumer',10),[usage])
    assert.deepEqual(restoredNews.listResearchReservations(10),[reservation])
    assert.deepEqual(restoredNews.getResearchV4Record('baseline','work-producer','baseline-producer'),{providerDispatchKnown:true,limitations:['Unknown charge remains held.']})
    const restored=new DatabaseSync(targetNews,{readOnly:true})
    try{
      assert.deepEqual(readSourceOwnership(restored,'news'),readSourceOwnership(news.db,'news'))
      assert.equal((restored.prepare('SELECT COUNT(*) AS n FROM news_source_delivery_outbox WHERE state=?').get('pending') as {n:number}).n,1)
      assert.equal((restored.prepare('SELECT COUNT(*) AS n FROM signal_platform_research_assignment_limits').get() as {n:number}).n,1)
    }finally{restored.close()}
    const incomplete=JSON.parse(readFileSync(newsBackup.manifestPath,'utf8')) as {tableCounts:Record<string,number>}
    delete incomplete.tableCounts.signal_platform_research_reservations
    writeFileSync(newsBackup.manifestPath,JSON.stringify(incomplete))
    assert.equal((await verifyNewsBackup(newsBackup.path)).ok,false,'v2 cannot claim complete durability coverage with an omitted present table')
  }finally{restoredNews?.close();restoredPoly?.close();poly.dispose();news.dispose();restore()}
})

test('pre-V4 v1 digest/schema-bound backup manifests remain restorable after the inventory upgrade',async()=>{
  const restore=withIsolatedV4Environment(),fixture=operationsFixture()
  try{
    const backup=await backupNewsStore({sourcePath:fixture.path,backupDir:join(fixture.dir,'backups'),now:OPERATIONS_NOW})
    const legacy=JSON.parse(readFileSync(backup.manifestPath,'utf8')) as {schemaVersion:string;tableCounts:Record<string,number>}
    legacy.schemaVersion='myboon.sqlite_backup_manifest.v1'
    for(const table of Object.keys(legacy.tableCounts))if(['signal_platform_store_identity','signal_platform_admission_dispositions','signal_platform_research_readiness','signal_platform_retrieval_manifests','signal_platform_artifact_pins','signal_platform_artifact_usages','signal_platform_research_v4_records','signal_platform_research_reservations','signal_platform_research_assignment_limits'].includes(table))delete legacy.tableCounts[table]
    writeFileSync(backup.manifestPath,JSON.stringify(legacy))
    assert.equal((await verifyNewsBackup(backup.path)).ok,true)
    assert.equal((await restoreNewsStore({backupPath:backup.path,targetPath:join(fixture.dir,'legacy-restored.sqlite')})).verified,true)
  }finally{fixture.dispose();restore()}
})
