import assert from 'node:assert/strict'
import test from 'node:test'
import { loadEntityManagerV4RuntimeConfig } from './runtime-config'

function researchEnv():Record<string,string>{return {
  ENTITY_V4_SOURCE_OWNERSHIP_ENABLED:'1',ENTITY_V4_ACTIVE_SOURCES:'news',ENTITY_V4_POLICY_VERSION:'reviewed-v4-policy',
  ENTITY_V4_ASSIGNMENT_POLICY_VERSION:'reviewed-assignment',ENTITY_V4_ASSIGNMENT_MAX_PROVIDER_CALLS:'4',
  ENTITY_V4_ASSIGNMENT_MAX_INPUT_TOKENS:'5000',ENTITY_V4_ASSIGNMENT_MAX_OUTPUT_TOKENS:'500',ENTITY_V4_ASSIGNMENT_MAX_COST_USD_MICROS:'unknown',
  ENTITY_V4_SYNTHESIS_POLICY_VERSION:'reviewed-synthesis',ENTITY_V4_SYNTHESIS_MAX_INPUT_TOKENS:'1000',
  ENTITY_V4_SYNTHESIS_MAX_OUTPUT_TOKENS:'100',ENTITY_V4_SYNTHESIS_MAX_COST_USD_MICROS:'unknown',
  ENTITY_V4_REUSE_POLICY_VERSION:'reviewed-reuse',ENTITY_V4_REUSE_MAX_EVIDENCE_AGE_MS:'60000',ENTITY_V4_REUSE_MAX_RESEARCH_AGE_MS:'120000',
  ENTITY_V4_FOLLOWUP_POLICY_VERSION:'reviewed-followup',ENTITY_V4_FOLLOWUP_MAX_PROVIDER_CALLS:'1',
  ENTITY_V4_FOLLOWUP_MAX_INPUT_TOKENS:'500',ENTITY_V4_FOLLOWUP_MAX_OUTPUT_TOKENS:'50',ENTITY_V4_FOLLOWUP_MAX_COST_USD_MICROS:'unknown',
  ENTITY_V4_FOLLOWUP_MAX_SOURCES:'1',ENTITY_V4_FOLLOWUP_MAX_TOTAL_BYTES:'2000',ENTITY_V4_FOLLOWUP_MAX_BYTES_PER_SOURCE:'1000',ENTITY_V4_FOLLOWUP_MAX_WALL_TIME_MS:'2000',
}}

test('disabled V4 configuration has no spending policy and never reads private database credentials',()=>{
  const env=new Proxy({} as Record<string,string|undefined>,{get(target,key){
    if(typeof key==='string'&&key.startsWith('MYBOON_MANAGED_KNOWLEDGE_'))assert.fail('disabled features inspected credentials')
    return Reflect.get(target,key)
  }})
  const config=loadEntityManagerV4RuntimeConfig(env)
  assert.equal(config.managedWriterEnabled,false);assert.equal(config.followupEnabled,false)
  assert.equal(config.assignmentPolicy,null);assert.equal(config.synthesisPolicy,null);assert.equal(config.followupPolicy,null)
  assert.equal(config.databaseUrl,null);assert.equal(config.databaseCa,null);assert.equal(config.activeSources.size,0)
})

test('enabled features require selected sources, durable ownership and explicit policy versions and limits',()=>{
  const env={...researchEnv(),ENTITY_V4_NOVELTY_ENABLED:'1'}
  for(const key of ['ENTITY_V4_ACTIVE_SOURCES','ENTITY_V4_POLICY_VERSION','ENTITY_V4_ASSIGNMENT_MAX_PROVIDER_CALLS','ENTITY_V4_SYNTHESIS_MAX_OUTPUT_TOKENS']){
    const incomplete:Record<string,string>={...env};delete incomplete[key]
    assert.throws(()=>loadEntityManagerV4RuntimeConfig(incomplete),/require/)
  }
  assert.throws(()=>loadEntityManagerV4RuntimeConfig({...env,ENTITY_V4_SOURCE_OWNERSHIP_ENABLED:'0'}),/persistent source ownership/)
  assert.throws(()=>loadEntityManagerV4RuntimeConfig({...env,ENTITY_V4_ACTIVE_SOURCES:'x'}),/does not admit source/)
  assert.throws(()=>loadEntityManagerV4RuntimeConfig({...env,ENTITY_V4_ASSIGNMENT_MAX_INPUT_TOKENS:'0'}),/positive safe integer/)
})

test('follow-up allows exactly one provider call, preserves unknown costs, and refuses invalid retrieval exposure',()=>{
  const env={...researchEnv(),ENTITY_V4_FOLLOWUP_ENABLED:'1'}
  const config=loadEntityManagerV4RuntimeConfig(env)
  assert.equal(config.followupPolicy?.maxProviderCalls,1)
  assert.equal(config.followupPolicy?.maxIncrementalCostUsdMicros,null)
  assert.equal(config.assignmentPolicy?.maxIncrementalCostUsdMicros,null)
  assert.throws(()=>loadEntityManagerV4RuntimeConfig({...env,ENTITY_V4_FOLLOWUP_MAX_PROVIDER_CALLS:'2'}),/exactly one/)
  assert.throws(()=>loadEntityManagerV4RuntimeConfig({...env,ENTITY_V4_FOLLOWUP_MAX_COST_USD_MICROS:''}),/required/)
  assert.throws(()=>loadEntityManagerV4RuntimeConfig({...env,ENTITY_V4_FOLLOWUP_MAX_COST_USD_MICROS:'-1'}),/non-negative/)
  assert.throws(()=>loadEntityManagerV4RuntimeConfig({...env,ENTITY_V4_FOLLOWUP_MAX_BYTES_PER_SOURCE:'3000'}),/cannot exceed total/)
})

test('every research feature can consult explicitly supplied private knowledge while writer credentials stay required',()=>{
  for(const flag of ['ENTITY_V4_NOVELTY_ENABLED','ENTITY_V4_RESEARCH_REUSE_ENABLED','ENTITY_V4_FOLLOWUP_ENABLED']){
    const env={...researchEnv(),[flag]:'1',MYBOON_MANAGED_KNOWLEDGE_DATABASE_URL:'postgresql://fixture_executor@example.com/fixture',MYBOON_MANAGED_KNOWLEDGE_DATABASE_CA:'fixture-ca'}
    const config=loadEntityManagerV4RuntimeConfig(env)
    assert.equal(config.databaseUrl,env.MYBOON_MANAGED_KNOWLEDGE_DATABASE_URL)
    assert.equal(config.databaseCa,'fixture-ca');assert.equal(config.managedWriterEnabled,false)
    delete (env as Record<string,string>).MYBOON_MANAGED_KNOWLEDGE_DATABASE_URL
    assert.equal(loadEntityManagerV4RuntimeConfig(env).databaseUrl,null)
  }
  assert.throws(()=>loadEntityManagerV4RuntimeConfig({...researchEnv(),ENTITY_V4_MANAGED_WRITER_ENABLED:'1'}),/MYBOON_MANAGED_KNOWLEDGE_DATABASE_URL.*required/)
})
