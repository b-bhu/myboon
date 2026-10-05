import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { readSourceOwnership, readSourceOwnershipObligations, type OwnershipSqliteDatabase, type SourceOwnershipSnapshot } from './source-ownership'
import type { EntityManagerV4Source } from './runtime-config'
import { loadEntityManagerV4RuntimeConfig } from './runtime-config'
import { EXECUTION_LEDGER_TABLE } from './sqlite-execution-ledger'

const { DatabaseSync }=createRequire(__filename)('node:sqlite') as {
  DatabaseSync:new(path:string,options:{readOnly:true})=>OwnershipSqliteDatabase
}

export interface V4OperationalMetric<T> { availability:'available'|'unavailable'; value:T|null; reason:string|null }
export interface V4SourceOperationalStatus {
  source:EntityManagerV4Source
  availability:'available'|'partial'|'unavailable'
  ownership:V4OperationalMetric<SourceOwnershipSnapshot|null>
  work:V4OperationalMetric<Record<string,number>>
  readiness:V4OperationalMetric<Record<string,number>>
  delivery:V4OperationalMetric<Record<string,number>>
  reservations:V4OperationalMetric<{
    byState:Record<string,number>; unknownOutcomeHolds:number; settledWithMeasuredCost:number;
    settledWithUnknownCost:number; measuredCostUsdMicros:number|null
  }>
  decisions:V4OperationalMetric<Record<string,number>>
  reuse:V4OperationalMetric<{evidenceReuses:number;researchReuses:number;rejectedResearchReuse:number}>
  providerUsage:V4OperationalMetric<{
    terminalEvents:number;providerCalls:number;inputTokens:number;outputTokens:number;repairCalls:number;
    measuredCostEvents:number;unmeasuredCostEvents:number;measuredCostUsdMicros:number|null;totalWallTimeMs:number
  }>
  obligations:V4OperationalMetric<ReturnType<typeof readSourceOwnershipObligations>>
}

/** Source-local durable records only; never opens a writable connection or initializes schemas. */
export function readV4SourceOperationalStatus(input:{databasePath:string;source:EntityManagerV4Source}):V4SourceOperationalStatus {
  let db:OwnershipSqliteDatabase|null=null
  const unavailable=<T>(reason:string):V4OperationalMetric<T>=>({availability:'unavailable',value:null,reason})
  const empty=():V4SourceOperationalStatus=>({
    source:input.source,availability:'unavailable',ownership:unavailable('source_database_unavailable'),
    work:unavailable('source_database_unavailable'),readiness:unavailable('source_database_unavailable'),delivery:unavailable('source_database_unavailable'),
    reservations:unavailable('source_database_unavailable'),decisions:unavailable('source_database_unavailable'),reuse:unavailable('source_database_unavailable'),
    providerUsage:unavailable('source_database_unavailable'),obligations:unavailable('source_database_unavailable'),
  })
  try {
    db=new DatabaseSync(resolve(input.databasePath),{readOnly:true})
    db.exec('PRAGMA busy_timeout=5000; BEGIN;')
    const read=<T>(operation:()=>T):V4OperationalMetric<T>=>{
      try{return {availability:'available',value:operation(),reason:null}}catch{return unavailable('durable_metric_unavailable')}
    }
    const grouped=(table:string,column:string,sourceColumn:string|null='source_type'):Record<string,number>=>{
      const rows=db!.prepare(`SELECT ${column} AS value,COUNT(*) AS n FROM ${table}${sourceColumn ? ` WHERE ${sourceColumn}=?` : ''} GROUP BY ${column} ORDER BY ${column}`).all(...(sourceColumn?[input.source]:[])) as Array<{value:string;n:number}>
      return Object.fromEntries(rows.map((row)=>[row.value,Number(row.n)]))
    }
    const result:V4SourceOperationalStatus={
      source:input.source,availability:'available',
      ownership:read(()=>readSourceOwnership(db!,input.source)),
      work:read(()=>grouped('signal_platform_research_work','status')),
      readiness:read(()=>grouped('signal_platform_research_readiness','outcome')),
      delivery:read(()=>grouped(input.source==='news'?'news_source_delivery_outbox':'pipeline_source_delivery_outbox','state')),
      reservations:read(()=>{
        const byState=grouped('signal_platform_research_reservations','state')
        const row=db!.prepare(`SELECT
          SUM(CASE WHEN state='settled' AND json_type(canonical_json,'$.settlement.usage.costUsdMicros')='integer' THEN 1 ELSE 0 END) AS known,
          SUM(CASE WHEN state='settled' AND COALESCE(json_type(canonical_json,'$.settlement.usage.costUsdMicros'),'null')<>'integer' THEN 1 ELSE 0 END) AS unknown,
          SUM(CASE WHEN state='settled' AND json_type(canonical_json,'$.settlement.usage.costUsdMicros')='integer' THEN json_extract(canonical_json,'$.settlement.usage.costUsdMicros') ELSE 0 END) AS cost
          FROM signal_platform_research_reservations WHERE source_type=?`).get(input.source) as {known:number|null;unknown:number|null;cost:number|null}
        return {byState,unknownOutcomeHolds:(byState.dispatch_intent??0)+(byState.execution_outcome_unknown??0),settledWithMeasuredCost:Number(row.known??0),settledWithUnknownCost:Number(row.unknown??0),measuredCostUsdMicros:row.known?Number(row.cost):null}
      }),
      decisions:read(()=>grouped('signal_platform_research_v4_records','kind')),
      reuse:read(()=>{
        const rows=db!.prepare(`SELECT kind,json_extract(canonical_json,'$.decision') AS decision,COUNT(*) AS n FROM signal_platform_research_v4_records WHERE source_type=? AND kind IN ('research_reuse','evidence_reuse') GROUP BY kind,decision`).all(input.source) as Array<{kind:string;decision:string|null;n:number}>
        return {evidenceReuses:rows.filter((r)=>r.kind==='evidence_reuse').reduce((n,r)=>n+Number(r.n),0),researchReuses:rows.filter((r)=>r.kind==='research_reuse'&&r.decision==='reuse_result').reduce((n,r)=>n+Number(r.n),0),rejectedResearchReuse:rows.filter((r)=>r.kind==='research_reuse'&&r.decision==='rejected').reduce((n,r)=>n+Number(r.n),0)}
      }),
      providerUsage:read(()=>{
        const row=db!.prepare(`SELECT COUNT(*) AS n,COALESCE(SUM(provider_calls),0) AS calls,COALESCE(SUM(input_tokens),0) AS input_tokens,
          COALESCE(SUM(output_tokens),0) AS output_tokens,COALESCE(SUM(repair_calls),0) AS repairs,COALESCE(SUM(wall_time_ms),0) AS duration,
          SUM(CASE WHEN json_type(event_json,'$.costUsdMicros')='integer' THEN 1 ELSE 0 END) AS measured,
          SUM(CASE WHEN json_type(event_json,'$.costUsdMicros')='integer' THEN json_extract(event_json,'$.costUsdMicros') ELSE 0 END) AS cost
          FROM ${EXECUTION_LEDGER_TABLE} WHERE source_type=? AND status<>'started'`).get(input.source) as Record<string,number|null>
        return {terminalEvents:Number(row.n??0),providerCalls:Number(row.calls??0),inputTokens:Number(row.input_tokens??0),outputTokens:Number(row.output_tokens??0),repairCalls:Number(row.repairs??0),measuredCostEvents:Number(row.measured??0),unmeasuredCostEvents:Number(row.n??0)-Number(row.measured??0),measuredCostUsdMicros:row.measured?Number(row.cost):null,totalWallTimeMs:Number(row.duration??0)}
      }),
      obligations:read(()=>readSourceOwnershipObligations(db!,input.source)),
    }
    const metrics=Object.values(result).filter((value):value is V4OperationalMetric<unknown>=>!!value&&typeof value==='object'&&'availability' in value)
    const available=metrics.filter((m)=>m.availability==='available').length
    result.availability=available===metrics.length?'available':available===0?'unavailable':'partial'
    db.exec('COMMIT')
    return result
  } catch {return empty()}
  finally{db?.close()}
}

export function readV4OperationalStatus(input:{newsPath:string;pipelinePath:string;now:string}) {
  return {
    schemaVersion:'myboon.entity_v4_operational_status.v1' as const,generatedAt:input.now,
    sources:{news:readV4SourceOperationalStatus({databasePath:input.newsPath,source:'news'}),polymarket:readV4SourceOperationalStatus({databasePath:input.pipelinePath,source:'polymarket'})},
  }
}

/** Internal operator counts use the private executor capability, never a downstream read API. */
export async function readManagedV4OperationalStatus() {
  let config:ReturnType<typeof loadEntityManagerV4RuntimeConfig>
  try{config=loadEntityManagerV4RuntimeConfig()}catch{return {availability:'unavailable' as const,sources:null,reason:'v4_runtime_configuration_invalid'}}
  if(!config.managedWriterEnabled)return {availability:'disabled' as const,sources:null,reason:'managed_writer_disabled'}
  let writer:import('../entity-manager/postgres-knowledge-writer').PostgresKnowledgeOperationWriter|null=null
  try{
    const {PostgresKnowledgeOperationWriter}=await import('../entity-manager/postgres-knowledge-writer')
    writer=new PostgresKnowledgeOperationWriter({connectionString:config.databaseUrl!,ca:config.databaseCa})
    const managedWriter=writer
    const results=await Promise.allSettled((['news','polymarket'] as const).map(async(source)=>{
      if(!config.activeSources.has(source))return [source,{availability:'disabled' as const,value:null,reason:'source_not_enabled'}] as const
      return [source,{availability:'available' as const,value:await managedWriter.readOperationalStatus(source),reason:null}] as const
    }))
    const sources=Object.fromEntries(results.map((result,index)=>result.status==='fulfilled'?result.value:[(['news','polymarket'] as const)[index],{availability:'unavailable',value:null,reason:'private_managed_status_unavailable'}]))
    return {availability:results.every((r)=>r.status==='fulfilled')?'available' as const:'partial' as const,sources,reason:null}
  }catch{return {availability:'unavailable' as const,sources:null,reason:'private_managed_status_unavailable'}}
  finally{if(writer)await writer.close().catch(()=>{})}
}
