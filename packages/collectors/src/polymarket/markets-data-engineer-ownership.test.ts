import assert from 'node:assert/strict'
import test from 'node:test'
import { runPolymarketMarketsDataEngineer } from './markets-data-engineer'
import type { SqlitePipelineStore } from '../pipeline-store/sqlite-store'
import { operationsFixture,withIsolatedV4Environment,OPERATIONS_NOW } from '../signal-platform/v4-operations.test-support'
import { sourceOwnershipAllows } from '../signal-platform/source-ownership'

test('paused Polymarket still freezes each material observation and baseline with intake off, without obsolete candidate admissions',async()=>{
  const restore=withIsolatedV4Environment(),fixture=operationsFixture('polymarket')
  const store=fixture.legacy as SqlitePipelineStore,originalFetch=globalThis.fetch
  let yesPrice=0.7
  const chain={select(){return this},eq(){return this},gte(){return this},order(){return this},async limit(){return {data:[],error:null}}}
  const supabase={from(){return chain}}
  globalThis.fetch=(async(url:string|URL|Request)=>new Response(JSON.stringify(String(url).includes('/tags/slug/')
    ? {id:'fixture-tag',label:'Crypto',slug:'crypto'}
    : [{id:'fixture-event',title:'Fixture market?',slug:'fixture-market',active:true,closed:false,updatedAt:OPERATIONS_NOW,
      markets:[{id:'fixture-market',conditionId:'fixture-market',slug:'fixture-market',question:'Fixture market?',active:true,closed:false,
        outcomePrices:JSON.stringify([yesPrice,1-yesPrice]),volume:1000,volume24hr:100,liquidity:100,updatedAt:OPERATIONS_NOW}]}]),{status:200,headers:{'content-type':'application/json'}})) as typeof fetch
  try{
    await store.upsertWatchlist([{source:'polymarket',area:'markets',tagSlug:'crypto',tagLabel:'Crypto',marketId:'fixture-market',slug:'fixture-market',title:'Fixture market?',eventSlug:null,eventTitle:null,endDate:null,
      isManualPin:false,rankInArea:1,watchScore:55,scoreBreakdown:{},selectionReason:'fixture-before-pause',latestObservedAt:'2026-10-03T08:00:00.000Z',
      latestYesPrice:0.5,latestVolume:1000,latestVolume24h:100,latestLiquidity:100,status:'active'}])
    fixture.run(fixture.receipt('initialize'))
    const options={now:OPERATIONS_NOW,tagSlugs:['crypto'],topMarketsPerTag:1,fetchLimitPerTag:10,includeManualPins:false}
    const gate=()=>sourceOwnershipAllows({databasePath:fixture.path,source:'polymarket',domain:'collector',owner:'legacy'})
    const first=await runPolymarketMarketsDataEngineer(store,supabase as never,options,undefined,gate,()=>true)
    assert.equal(first.candidatesWritten,0);assert.equal(first.candidateThreadsUpdated,0)
    const owed=await store.listPendingSourceDeliveries(10)
    assert.equal(owed.length,1)
    const frozen=JSON.stringify(owed[0].signal)
    assert.equal((await store.getBacklogDepth({source:'polymarket',area:'markets',now:OPERATIONS_NOW})).candidatesPending,0)
    yesPrice=0.9
    await runPolymarketMarketsDataEngineer(store,supabase as never,{...options,now:'2026-10-03T09:02:00.000Z'},undefined,gate,()=>true)
    const after=await store.listPendingSourceDeliveries(10)
    assert.equal(after.length,2)
    assert.equal(JSON.stringify(after.find((record)=>record.signalId===owed[0].signalId)?.signal),frozen,'new baseline must never overwrite an earlier undelivered observation')
    assert.equal((fixture.db.prepare("SELECT COUNT(*) AS n FROM pipeline_candidates WHERE source='polymarket'").get() as {n:number}).n,0)
    assert.throws(()=>fixture.db.prepare("INSERT INTO pipeline_candidates(id,source,area,candidate_type,market_id,slug,title,observed_at,what_changed,why_flagged,score,dedupe_key) VALUES ('obsolete','polymarket','markets','odds_moved','fixture-market','fixture-market','Fixture',?,'changed','flagged',0.8,'obsolete-key')").run(OPERATIONS_NOW),/V4_SOURCE_OWNERSHIP_FENCED/)
  }finally{globalThis.fetch=originalFetch;fixture.dispose();restore()}
})
