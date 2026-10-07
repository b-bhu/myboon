import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { canonicalJson } from '../signal-platform/canonical-json'
import { IsolatedEntityPostgres } from './isolated-postgres.test-support'
import { ACME_ID, fixturePort, managedFixture, MANAGED_TEST_NOW } from './managed-v4.test-support'
import { ManagedCanonicalPacketProcessor } from './managed-canonical-processor'
import { PostgresKnowledgeOperationWriter } from './postgres-knowledge-writer'
import {
  KnowledgeOperationConflictError, KnowledgeOperationFencingError, KnowledgeOperationStaleTargetError,
  knowledgeOperationSemanticDigest, knowledgeOperationHoldContentDigest, type KnowledgeOperationCommitInput,
} from './knowledge-operation-store'
import { progressionPlanDigest, validateProgressionPlan } from './progression-plan'
import { buildProgressionEffects, deriveProgressionAttemptDigest, deriveProgressionOperationId, type ProgressionPlanMetadata } from './progression-processor'
import { progressionSourcePacketDigest } from './progression-source-packet-reader'
import { SharedEntityWorker } from './shared-worker'
import { sharedEntityWorkerConfig } from './shared-worker-config'
import type { GenerateStructuredRequest, InferenceTelemetry } from '../inference-gateway/types'
import type { LeasedTransitionCommand } from '../signal-platform/store-adapter'
import { createResolvedWithoutNewItemReadiness } from '../signal-platform/research-readiness'

const MOCK_TELEMETRY: InferenceTelemetry = {
  workload:'entity.extract',purpose:'fixture',mode:'generateStructured',promptVersion:'fixture',policyVersion:'fixture',
  configuredPrimaryProvider:'fixture',configuredPrimaryModel:'mock',actualProvider:'fixture',actualModel:'mock',fallbackInvoked:false,fallbackReason:null,
  schemaValid:true,providerCalls:1,repairCalls:0,inputTokens:10,outputTokens:10,toolCalls:0,costUsdMicros:null,
  configuredReasoningEffort:null,actualReasoningEffort:null,durationMs:1,budgetExceeded:false,failureCategory:null,calls:[],
}

type Fixture = ReturnType<typeof managedFixture>
function edge(input: Fixture) {
  return {claimId:input.canonicalPacket.claims[0].claimId,evidenceId:input.canonicalPacket.evidence[0].evidenceId,sourceRef:input.canonicalPacket.evidence[0].url}
}
function draft(input: Fixture, localKey = 'development') {
  return {localKey,candidateId:'model-must-not-persist',note:input.canonicalPacket.claims[0].claim,
    entityLinks:[{candidateEntityRef:ACME_ID,role:'subject'}],continuityLinks:[],evidenceRefs:[edge(input)]}
}

async function applyDedicatedLoginMigration(database: IsolatedEntityPostgres): Promise<void> {
  const sql = readFileSync(resolve(__dirname,'../../../../supabase/migrations/20261003090001_entity_manager_v4_dedicated_logins.sql'),'utf8')
  const deployer = database.pool('fixture_deployer')
  const connection = await deployer.connect()
  try {
    await connection.query('BEGIN')
    await connection.query(sql)
    await connection.query('COMMIT')
  } catch(error) {
    await connection.query('ROLLBACK')
    throw error
  } finally {connection.release();await deployer.end()}
}

test('password-free dedicated login migration preserves credentials and rejects incompatible identities under hosted role parity',{
  skip:process.env.ENTITY_V4_RUN_POSTGRES_TESTS !== '1',timeout:180_000,
},async (t) => {
  for(const existing of [false,true]) await t.test(existing ? 'compatible existing logins preserve SCRAM credentials/settings and permit named context' : 'fresh logins are minimal and have no committed credentials',async () => {
    const database = new IsolatedEntityPostgres()
    try {
      await database.start();await database.migrate({nonSuperuserAdmin:true})
      if(existing) await database.admin.query(`
        CREATE ROLE myboon_v4_worker LOGIN INHERIT PASSWORD 'isolated_fixture_only';
        CREATE ROLE myboon_v4_research LOGIN INHERIT PASSWORD 'isolated_fixture_only';
        GRANT myboon_knowledge_executor TO myboon_v4_worker;
        GRANT myboon_knowledge_context_executor TO myboon_v4_research;
        ALTER ROLE myboon_v4_worker SET statement_timeout='12345';
      `)
      const authState = () => database.admin.query("select a.rolname,a.rolpassword,s.setconfig as rolconfig from pg_authid a left join pg_db_role_setting s on s.setrole=a.oid and s.setdatabase=0 where a.rolname in ('myboon_v4_worker','myboon_v4_research') order by a.rolname")
      const before = await authState()
      await applyDedicatedLoginMigration(database)
      const after = await authState()
      if(existing) {
        assert.deepEqual(after.rows,before.rows,'Migration must preserve operator credentials and connection settings')
        assert.ok(after.rows.every((row) => row.rolpassword?.startsWith('SCRAM-SHA-256$')))
      } else assert.ok(after.rows.every((row) => row.rolpassword === null))
      const attributes = await database.admin.query("select rolname,rolcanlogin,rolinherit,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication from pg_roles where rolname in ('myboon_v4_worker','myboon_v4_research') order by rolname")
      assert.equal(attributes.rows.length,2)
      for(const row of attributes.rows)assert.deepEqual({...row,rolname:undefined},{rolname:undefined,rolcanlogin:true,rolinherit:true,rolsuper:false,rolbypassrls:false,rolcreatedb:false,rolcreaterole:false,rolreplication:false})
      // PostgreSQL 17 retains separate equivalent grants from each grantor.
      // DISTINCT includes every privilege option, so an unexpected ADMIN,
      // INHERIT or SET option still produces a failing logical membership.
      const memberships = await database.admin.query("select distinct member.rolname,parent.rolname as parent,m.admin_option,m.inherit_option,m.set_option from pg_auth_members m join pg_roles member on member.oid=m.member join pg_roles parent on parent.oid=m.roleid where member.rolname in ('myboon_v4_worker','myboon_v4_research') order by member.rolname")
      assert.deepEqual(memberships.rows,[
        {rolname:'myboon_v4_research',parent:'myboon_knowledge_context_executor',admin_option:false,inherit_option:true,set_option:true},
        {rolname:'myboon_v4_worker',parent:'myboon_knowledge_executor',admin_option:false,inherit_option:true,set_option:true},
      ])
      const membershipState = () => database.admin.query("select member.rolname,parent.rolname as parent,grantor.rolname as grantor,m.admin_option,m.inherit_option,m.set_option from pg_auth_members m join pg_roles member on member.oid=m.member join pg_roles parent on parent.oid=m.roleid join pg_roles grantor on grantor.oid=m.grantor where member.rolname in ('myboon_v4_worker','myboon_v4_research') order by member.rolname,grantor.rolname")
      const grantorsBefore = await membershipState()
      assert.equal(grantorsBefore.rows.length,existing ? 4 : 2)
      if(existing)assert.deepEqual([...new Set(grantorsBefore.rows.map((row) => row.grantor))].sort(),['fixture_deployer','postgres'])
      await applyDedicatedLoginMigration(database)
      assert.deepEqual((await membershipState()).rows,grantorsBefore.rows,'Repeated migration must not add or alter grantor-specific privileges')
      assert.deepEqual((await authState()).rows,after.rows)
      if(!existing) await database.admin.query("alter role myboon_v4_worker password 'isolated_fixture_only';alter role myboon_v4_research password 'isolated_fixture_only'")
      for(const login of ['myboon_v4_worker','myboon_v4_research']) {
        const direct = database.pool(login)
        try {
          const connection = await direct.query('select session_user,(select ssl from pg_stat_ssl where pid=pg_backend_pid()) as tls')
          assert.deepEqual(connection.rows[0],{session_user:login,tls:true})
          const context = await direct.query('select managed_knowledge_private.context_v1($1::jsonb) as result',[{labels:['ACME']}])
          assert.equal(context.rows[0].result.entities[0].id,ACME_ID)
          const denied = (error:unknown) => (error as {code?:string}).code === '42501'
          await assert.rejects(direct.query('select * from managed_knowledge_private.items'),denied)
          await assert.rejects(direct.query('set role myboon_knowledge_owner'),denied)
          if(login === 'myboon_v4_research')await assert.rejects(direct.query("select managed_knowledge_private.writer_v1('status','{}'::jsonb)"),denied)
        } finally {await direct.end()}
      }
    } finally {await database.close()}
  })
  for(const defect of ['bypass_rls','create_role','service_membership','executor_admin_membership'] as const) await t.test(`existing research login with ${defect} fails atomically without credential or privilege changes`,async () => {
    const database = new IsolatedEntityPostgres()
    try {
      await database.start();await database.migrate({nonSuperuserAdmin:true})
      await database.admin.query(`CREATE ROLE myboon_v4_research LOGIN INHERIT PASSWORD 'isolated_fixture_only' ${defect === 'bypass_rls' ? 'BYPASSRLS' : ''} ${defect === 'create_role' ? 'CREATEROLE' : ''}`)
      if(defect === 'service_membership')await database.admin.query('GRANT service_role TO myboon_v4_research')
      if(defect === 'executor_admin_membership')await database.admin.query('GRANT myboon_knowledge_context_executor TO myboon_v4_research WITH ADMIN OPTION')
      const snapshot = async () => ({
        roles:(await database.admin.query("select a.rolname,a.rolpassword,s.setconfig as rolconfig,a.rolbypassrls,a.rolcreaterole from pg_authid a left join pg_db_role_setting s on s.setrole=a.oid and s.setdatabase=0 where a.rolname in ('myboon_v4_worker','myboon_v4_research') order by a.rolname")).rows,
        grants:(await database.admin.query("select m.roleid,m.member,m.admin_option,m.inherit_option,m.set_option from pg_auth_members m join pg_roles r on r.oid=m.member where r.rolname in ('myboon_v4_worker','myboon_v4_research') order by m.roleid")).rows,
      })
      const before = await snapshot()
      await assert.rejects(applyDedicatedLoginMigration(database),(error:unknown) => (error as {code?:string}).code === '42501' && /minimal dedicated identity/.test((error as Error).message))
      assert.deepEqual(await snapshot(),before)
      assert.equal((await database.admin.query("select to_regrole('myboon_v4_worker')::text as worker")).rows[0].worker,null,'First login creation must roll back when the second login is incompatible')
    } finally {await database.close()}
  })
})

async function prepare(writer: PostgresKnowledgeOperationWriter,input: Fixture,outcome: unknown = {kind:'apply',drafts:[draft(input)],operations:[]}, allowForgedEvidence = false) {
  await writer.saveResearchSource(input.canonicalPacket,input.handoffContext)
  const itemIds = (outcome as {operations?:Array<{candidateItemRef?:string}>}).operations?.flatMap((operation) => operation.candidateItemRef ? [operation.candidateItemRef]:[]) ?? []
  const context = await writer.researchContext({labels:['Acme'],itemIds,limit:32})
  const targetRevisions = Object.fromEntries([...context.entities.map((entity) => [entity.id,entity.revision]),...context.items.map((item) => [item.itemId,item.revision])])
  await writer.savePlanningContext(input.work.workId,{contextDigest:context.digest,watermark:context.watermark,entities:context.entities,itemRevisions:Object.fromEntries(context.items.map((item) => [item.itemId,item.revision]))})
  const metadata: ProgressionPlanMetadata = {packetDigest:progressionSourcePacketDigest(input.canonicalPacket),contextDigest:context.digest,contextWatermark:context.watermark,
    policyVersion:'fixture.v1',promptVersion:'fixture.v1',decisionVersions:{readiness:knowledgeOperationSemanticDigest(input.handoffContext.readiness)},targetRevisions}
  const operationId = deriveProgressionOperationId(input.work.workId)
  const lease = await writer.acquireLease(operationId,'fixture-owner')
  assert.ok(lease)
  const plan = validateProgressionPlan({contractVersion:1,operationId,workId:input.work.workId,...metadata,outcome},
    (candidate) => context.entities.find((entity) => entity.id === candidate)?.id ?? null,
    (candidate) => context.items.find((item) => item.itemId === candidate)?.itemId ?? null,
    (candidate) => allowForgedEvidence || canonicalJson(candidate) === canonicalJson(edge(input)) ? candidate:null)
  const saved = await writer.saveValidatedPlan({operationId,workId:input.work.workId,owner:lease.owner,epoch:lease.epoch,
    attemptDigest:deriveProgressionAttemptDigest(operationId,metadata),plan,planDigest:progressionPlanDigest(plan)})
  const effects = plan.outcome.kind === 'apply' ? buildProgressionEffects(operationId,plan.outcome.drafts,plan.outcome.operations):[]
  const commit: KnowledgeOperationCommitInput = {operationId,workId:input.work.workId,owner:lease.owner,epoch:lease.epoch,
    attemptDigest:saved.attemptDigest,planRevision:saved.revision,planDigest:saved.planDigest,contentDigest:knowledgeOperationSemanticDigest(effects),targetRevisions,
    expectedAbsentItemIds:effects.filter((effect) => effect.kind === 'managed_item').map((effect) => effect.itemId),effects}
  return {commit,lease,plan,saved,metadata}
}

test('hosted PostgreSQL administrator parity preserves least privilege and rejects existing elevated private roles',{
  skip:process.env.ENTITY_V4_RUN_POSTGRES_TESTS !== '1',timeout:180_000,
},async (t) => {
  for (const preexistingMinimalRoles of [false,true]) {
    await t.test(`non-superuser CREATEROLE deployer applies migration with ${preexistingMinimalRoles ? 'existing minimal':'new'} private roles`,async () => {
      const database = new IsolatedEntityPostgres()
      let writer: PostgresKnowledgeOperationWriter | undefined
      try {
        await database.start()
        await database.migrate({nonSuperuserAdmin:true,preexistingMinimalRoles})
        writer = database.writer()
        assert.equal((await writer.researchContext({labels:['ACME']})).entities[0].id,ACME_ID)
        const delegation = await database.admin.query("select admin_option,inherit_option,set_option from pg_auth_members m join pg_roles r on r.oid=m.roleid join pg_roles member on member.oid=m.member where r.rolname='myboon_knowledge_owner' and member.rolname='fixture_deployer'")
        assert.deepEqual(delegation.rows[0],{admin_option:true,inherit_option:false,set_option:false})
        const owner = await database.admin.query("select r.rolname,p.prosecdef,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_roles r on r.oid=p.proowner where n.nspname='managed_knowledge_private' and p.proname='writer_v1'")
        assert.equal(owner.rows[0].rolname,'myboon_knowledge_owner')
        assert.equal(owner.rows[0].prosecdef,true)
        const direct = database.pool('v4_writer_fixture')
        try {await assert.rejects(direct.query('select * from managed_knowledge_private.items'),(error:unknown) => (error as {code?:string}).code === '42501')} finally {await direct.end()}
      } finally {if(writer)await writer.close();await database.close()}
    })
  }
  for (const existingElevatedRole of ['login','bypass_rls','membership'] as const) {
    await t.test(`existing private owner with ${existingElevatedRole} is rejected without demotion`,async () => {
      const database = new IsolatedEntityPostgres()
      try {
        await database.start()
        await assert.rejects(database.migrate({nonSuperuserAdmin:true,existingElevatedRole}),
          (error:unknown) => (error as {code?:string}).code === '42501' && /isolated minimal NOLOGIN role/.test((error as Error).message))
        assert.equal((await database.admin.query("select to_regnamespace('managed_knowledge_private')::text as schema")).rows[0].schema,null)
        const role = await database.admin.query("select rolcanlogin,rolbypassrls from pg_roles where rolname='myboon_knowledge_owner'")
        assert.equal(role.rows[0].rolcanlogin,existingElevatedRole === 'login')
        assert.equal(role.rows[0].rolbypassrls,existingElevatedRole === 'bypass_rls')
        if(existingElevatedRole === 'membership')assert.equal((await database.admin.query("select pg_has_role('myboon_knowledge_owner','service_role','member') as member")).rows[0].member,true)
      } finally {await database.close()}
    })
  }
})

test('private managed PostgreSQL writer: real migration, roles, fencing, provenance and crash recovery',{
  skip:process.env.ENTITY_V4_RUN_POSTGRES_TESTS !== '1',timeout:180_000,
},async (t) => {
  const database = new IsolatedEntityPostgres()
  t.diagnostic(`Disposable PostgreSQL server artifacts: ${database.directory}`)
  let writer: PostgresKnowledgeOperationWriter | undefined
  try {
    await database.start()
    await database.migrate()
    writer = database.writer()
    const store = writer
    let accepted: Awaited<ReturnType<typeof prepare>>
    let acceptedItemId = ''

    await t.test('TLS, exact legacy JSONB aliases, and immutable source retrieval provenance',async () => {
      const untrusted = new PostgresKnowledgeOperationWriter({...database.writerOptions(),ca:null})
      try {await assert.rejects(untrusted.findReceipt(deriveProgressionOperationId('untrusted-tls')),/storage unavailable/)} finally {await untrusted.close()}
      const context = await store.researchContext({labels:['ACME']})
      assert.equal(context.entities[0].id,ACME_ID)
      const input = managedFixture('provenance')
      await store.saveResearchSource(input.canonicalPacket,input.handoffContext)
      const persisted = await database.admin.query('select retrieved_evidence,packet,readiness,source_refs from managed_knowledge_private.sources where work_id=$1',[input.work.workId])
      assert.equal(persisted.rows[0].retrieved_evidence[0].requestedUrl,input.handoffContext.persistedEvidence[0].requestedUrl)
      assert.equal(persisted.rows[0].retrieved_evidence[0].contentHash,input.handoffContext.persistedEvidence[0].contentHash)
      assert.equal(persisted.rows[0].packet.sourceSignal.provenance.provider,'fixture')
      assert.ok(persisted.rows[0].source_refs.includes('native-provenance'))
      await assert.rejects(store.saveResearchSource({...input.canonicalPacket,claims:[{...input.canonicalPacket.claims[0],claim:'A changed claim'}]},input.handoffContext),KnowledgeOperationConflictError)
    })

    await t.test('function-only writer and context roles cannot mutate or expose private tables',async () => {
      const writerPool = database.pool('v4_writer_fixture')
      const readerPool = database.pool('v4_reader_fixture')
      const apiPool = database.pool('v4_api_fixture')
      const denied = (error: unknown) => (error as {code?:string}).code === '42501'
      try {
        for (const statement of ['select * from managed_knowledge_private.items','insert into managed_knowledge_private.items(id,note,payload,operation_id,work_id,observed_at) values(gen_random_uuid(),\'forged\',\'{}\',\'bad\',\'bad\',now())','update public.entities set updated_at=now()']) {
          await assert.rejects(writerPool.query(statement),denied)
        }
        await readerPool.query("select managed_knowledge_private.context_v1('{\"labels\":[\"Acme\"]}')")
        await assert.rejects(readerPool.query("select managed_knowledge_private.writer_v1('receipt','{}')"),denied)
        await assert.rejects(apiPool.query("select managed_knowledge_private.context_v1('{}')"),denied)
        await assert.rejects(apiPool.query("select managed_knowledge_private.writer_v1('status','{}')"),denied)
        // Even accidental execution membership cannot admit an API identity.
        await database.admin.query('grant myboon_knowledge_executor to v4_api_fixture')
        await assert.rejects(apiPool.query("select managed_knowledge_private.writer_v1('status','{}')"),denied)
        await assert.rejects(apiPool.query("select managed_knowledge_private.context_v1('{}')"),denied)
        const role = await database.admin.query("select rolcanlogin,rolsuper,rolbypassrls from pg_roles where rolname='myboon_knowledge_owner'")
        assert.deepEqual(role.rows[0],{rolcanlogin:false,rolsuper:false,rolbypassrls:false})
        const functions = await database.admin.query("select proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='managed_knowledge_private'")
        assert.ok(functions.rows.every((row) => row.proconfig.includes('search_path=pg_catalog')))
        const grants = await database.admin.query("select has_schema_privilege('myboon_knowledge_owner','managed_knowledge_private','CREATE') as create,has_table_privilege('myboon_knowledge_owner','managed_knowledge_private.items','UPDATE') as update,has_table_privilege('myboon_knowledge_owner','managed_knowledge_private.history','DELETE') as delete,has_function_privilege('anon','managed_knowledge_private.digest_v1(jsonb)','EXECUTE') as public_helper")
        assert.deepEqual(grants.rows[0],{create:false,update:false,delete:false,public_helper:false})
      } finally {await Promise.all([writerPool.end(),readerPool.end(),apiPool.end()])}
    })

    await t.test('concurrent leases select one winner and stale epochs cannot save/renew/release',async () => {
      const input = managedFixture('epochs')
      const prepared = await prepare(store,input)
      await store.releaseLease(prepared.lease.operationId,prepared.lease.owner,prepared.lease.epoch)
      const leases = await Promise.all(['owner-a','owner-b','owner-c'].map((owner) => store.acquireLease(prepared.commit.operationId,owner)))
      assert.equal(leases.filter(Boolean).length,1)
      const winner = leases.find((lease) => lease !== null)!
      assert.ok(winner.epoch > prepared.lease.epoch)
      assert.equal(await store.releaseLease(prepared.lease.operationId,prepared.lease.owner,prepared.lease.epoch),false)
      assert.equal(await store.renewLease(prepared.lease.operationId,prepared.lease.owner,prepared.lease.epoch),null)
      await assert.rejects(store.commitOperations(prepared.commit),KnowledgeOperationFencingError)
      await assert.rejects(store.saveValidatedPlan({operationId:prepared.commit.operationId,workId:input.work.workId,owner:prepared.lease.owner,epoch:prepared.lease.epoch,attemptDigest:prepared.saved.attemptDigest,plan:prepared.plan,planDigest:prepared.saved.planDigest}),KnowledgeOperationFencingError)
      await store.releaseLease(winner.operationId,winner.owner,winner.epoch)
    })

    await t.test('atomic receipt failure rolls back all effects; saved plan resumes after client loss',async () => {
      accepted = await prepare(store,managedFixture('atomic'))
      await database.admin.query(`create function public.fixture_receipt_failure() returns trigger language plpgsql as $$begin raise exception 'fixture terminal receipt failure'; end$$;
        create trigger fixture_receipt_failure before insert on managed_knowledge_private.receipts for each row execute function public.fixture_receipt_failure();`)
      await assert.rejects(store.commitOperations(accepted.commit),/storage unavailable/)
      for (const table of ['items','evidence','history','receipts']) {
        const rows = await database.admin.query(`select count(*)::int as count from managed_knowledge_private.${table} where operation_id=$1`,[accepted.commit.operationId])
        assert.equal(rows.rows[0].count,0,`${table} must roll back`)
      }
      assert.equal((await store.findSavedPlanHistory(accepted.commit.operationId)).length,1)
      await database.admin.query('drop trigger fixture_receipt_failure on managed_knowledge_private.receipts; drop function public.fixture_receipt_failure()')
      await writer!.close()
      writer = database.writer()
      assert.equal((await writer.findSavedPlan(accepted.commit.operationId,accepted.commit.attemptDigest))?.planDigest,accepted.commit.planDigest)
      const result = await writer.commitOperations(accepted.commit)
      assert.equal(result.receipt.status,'accepted')
      acceptedItemId = accepted.commit.expectedAbsentItemIds[0]
      const replay = await writer.commitOperations({...accepted.commit,owner:'stale-owner',epoch:999})
      assert.equal(replay.alreadyAccepted,true)
      assert.deepEqual(replay.receipt,result.receipt)
      // `store` was intentionally disconnected above; continue through the new writer below.
    })

    const active = () => writer!
    await t.test('held attempt and prior checkpoint remain immutable after a later accepted revision',async () => {
      const input = managedFixture('hold-history')
      const held = await prepare(active(),input,{kind:'hold',reason:'Grounding dependency needs resolution',missingDependency:'fixture-grounding'})
      const content = {reason:'Grounding dependency needs resolution',missingDependency:'fixture-grounding',retainedGroups:0,retainedPayload:null}
      const result = await active().commitHold({operationId:held.commit.operationId,workId:input.work.workId,owner:held.lease.owner,epoch:held.lease.epoch,
        attemptDigest:held.saved.attemptDigest,planRevision:held.saved.revision,planDigest:held.saved.planDigest,contentDigest:knowledgeOperationHoldContentDigest(content),...content})
      assert.equal(result.receipt.status,'held')
      assert.equal(await active().findReceipt(held.commit.operationId),null)
      assert.equal(await active().findSavedPlan(held.commit.operationId,held.saved.attemptDigest),null)
      await active().releaseLease(held.lease.operationId,held.lease.owner,held.lease.epoch)
      const retry = await prepare(active(),input)
      assert.equal(retry.saved.revision,2)
      await active().commitOperations(retry.commit)
      assert.deepEqual(await active().findHoldHistory(held.commit.operationId),[result.receipt])
      const history = await active().findSavedPlanHistory(held.commit.operationId)
      assert.equal(history.length,2)
      assert.deepEqual(history[0],held.saved)
      assert.equal((await active().findReceipt(held.commit.operationId))?.planRevision,2)
    })
    await t.test('backend termination mid-transaction leaves no effects; concurrent saved-plan replay commits once',async () => {
      const attempt = await prepare(active(),managedFixture('connection-crash'))
      await database.admin.query(`create function public.fixture_receipt_sleep() returns trigger language plpgsql as $$begin perform pg_sleep(30); return new; end$$;
        create trigger fixture_receipt_sleep before insert on managed_knowledge_private.receipts for each row execute function public.fixture_receipt_sleep();`)
      try {
        const pending = active().commitOperations(attempt.commit).then((result) => ({result,error:null}),(error:unknown) => ({result:null,error}))
        let pid: number | undefined
        for (let poll = 0; poll < 100; poll += 1) {
          const activity = await database.admin.query("select pid from pg_stat_activity where datname=current_database() and application_name='myboon_entity_v4_private_writer' and wait_event='PgSleep'")
          pid = activity.rows[0]?.pid
          if (pid) break
          await new Promise((resolvePromise) => setTimeout(resolvePromise,20))
        }
        assert.ok(pid,'fixture commit reached the terminal receipt boundary')
        assert.equal((await database.admin.query('select pg_terminate_backend($1) as terminated',[pid])).rows[0].terminated,true)
        const interrupted = await pending
        assert.equal(interrupted.result,null)
        assert.ok(interrupted.error instanceof Error)
        assert.match(interrupted.error.message,/storage unavailable/)
      } finally {await database.admin.query('drop trigger fixture_receipt_sleep on managed_knowledge_private.receipts; drop function public.fixture_receipt_sleep()')}
      for (const table of ['items','evidence','history','receipts']) {
        assert.equal((await database.admin.query(`select count(*)::int as count from managed_knowledge_private.${table} where operation_id=$1`,[attempt.commit.operationId])).rows[0].count,0)
      }
      const replay = await Promise.all([active().commitOperations(attempt.commit),active().commitOperations(attempt.commit)])
      assert.equal(replay.filter((result) => !result.alreadyAccepted).length,1)
      assert.deepEqual(replay[0].receipt,replay[1].receipt)
      assert.equal((await database.admin.query('select count(*)::int as count from managed_knowledge_private.history where operation_id=$1',[attempt.commit.operationId])).rows[0].count,2)
    })
    await t.test('missing admission, changed linkage, digests and forged evidence cannot enter managed effects',async () => {
      const direct = database.pool('v4_writer_fixture')
      try {
        for (const variant of ['missing-outcome','wrong-signal','wrong-digest']) {
          const input = managedFixture(`forged-${variant}`)
          const readiness: Record<string,unknown> = {...input.handoffContext.readiness}
          if (variant === 'missing-outcome') delete readiness.outcome
          if (variant === 'wrong-signal') readiness.signalId = 'different-source-signal'
          const source = {workId:input.work.workId,packet:input.canonicalPacket,packetCanonical:canonicalJson(input.canonicalPacket),
            packetDigest:variant === 'wrong-digest' ? 'f'.repeat(64):progressionSourcePacketDigest(input.canonicalPacket),
            readiness,readinessCanonical:canonicalJson(readiness),readinessDigest:knowledgeOperationSemanticDigest(readiness),source:'news',sourceRefs:['fixture'],evidence:[]}
          await assert.rejects(direct.query('select managed_knowledge_private.writer_v1($1,$2::jsonb)',['source',source]),(error:unknown) => (error as {code?:string}).code === 'MK001',variant)
        }
      } finally {await direct.end()}
      const input = managedFixture('forged-evidence')
      const forgedDraft = {...draft(input),evidenceRefs:[{...edge(input),sourceRef:'https://forged.example/unsupported'}]}
      const attempt = await prepare(active(),input,{kind:'apply',drafts:[forgedDraft],operations:[]},true)
      await assert.rejects(active().commitOperations(attempt.commit),KnowledgeOperationConflictError)
      for (const table of ['items','evidence','history','receipts']) {
        assert.equal((await database.admin.query(`select count(*)::int as count from managed_knowledge_private.${table} where operation_id=$1`,[attempt.commit.operationId])).rows[0].count,0)
      }
    })
    await t.test('receipt replay bypasses source hydration, ownership and unavailable provider configuration',async () => {
      const input = managedFixture('atomic')
      const processor = new ManagedCanonicalPacketProcessor({writer:active(),ports:[{...fixturePort(input),async readResearchPacket(){throw new Error('must not hydrate accepted work')}}],
        owner:'different-owner',policyVersion:'changed-policy',gatewayFactory(){throw new Error('must not construct paid provider')},assertOwnership(){throw new Error('must not check current ownership')},executeOwned(){throw new Error('must not begin new processing')}})
      assert.deepEqual(await processor.recoverAccepted(input.work),{entityTelemetry:null,memoryOutcome:'written'})
      assert.deepEqual(await processor.process(input),{entityTelemetry:null,memoryOutcome:'written'})
      const native = await active().researchContext({source:'news',sourceRefs:['native-atomic']})
      const url = await active().researchContext({source:'news',sourceRefs:[input.canonicalPacket.sourceSignal.canonicalUrl!]})
      assert.ok(native.items.some((item) => item.itemId === acceptedItemId))
      assert.ok(url.items.some((item) => item.itemId === acceptedItemId))
      const transitions: LeasedTransitionCommand[] = []
      const worker = new SharedEntityWorker({config:sharedEntityWorkerConfig({ownership:{news:'shared'},runtimeTopology:{news:{legacyActiveClaimers:0,sharedActiveClaimers:1}}}),
        workerId:'recovery-worker',processor,now:() => new Date(MANAGED_TEST_NOW),heartbeatScheduler:{schedule:() => () => {}},shadowObservations:{async observe(){}},
        ports:[{...fixturePort(input),async readResearchPacket(){throw new Error('worker hydrated accepted packet')},async readHandoffContext(){throw new Error('worker hydrated accepted readiness')},
          async claimWithLease(command){return {work:{...input.work,status:'entity_leased',updatedAt:command.now},leaseOwner:command.leaseOwner,leaseId:command.leaseId,leaseExpiresAt:command.leaseExpiresAt,queuedAt:input.work.updatedAt}},
          async transitionLeased(command){transitions.push(command);return true}}]})
      const cycle = await worker.runActiveCycle()
      assert.equal(cycle.completed,1)
      assert.equal(cycle.deadLettered,0)
      assert.equal(transitions[0].nextStatus,'complete')
    })

    await t.test('target revisions and exact expected absence reject races without partial writes',async () => {
      const input = managedFixture('stale')
      const stale = await prepare(active(),input)
      await database.admin.query('update public.entities set updated_at=updated_at+interval \'1 second\' where id=$1',[ACME_ID])
      await assert.rejects(active().commitOperations(stale.commit),KnowledgeOperationStaleTargetError)
      assert.equal(await active().findReceipt(stale.commit.operationId),null)
      const mismatch = await prepare(active(),managedFixture('absent'))
      await assert.rejects(active().commitOperations({...mismatch.commit,expectedAbsentItemIds:[]}),/expectedAbsentItemIds must exactly match/)
      const direct = database.pool('v4_writer_fixture')
      try {
        await assert.rejects(direct.query('select managed_knowledge_private.writer_v1($1,$2::jsonb)', ['commit',{...mismatch.commit,expectedAbsentItemIds:[],effectsCanonical:canonicalJson(mismatch.commit.effects)}]),
          (error: unknown) => (error as {code?:string}).code === 'MK001')
      } finally {await direct.end()}
      assert.equal(await active().findReceipt(mismatch.commit.operationId),null)
      const collision = await prepare(active(),managedFixture('real-absent-collision'))
      const collisionId = collision.commit.expectedAbsentItemIds[0]
      // An isolated administrative fixture occupies the code-derived ID after planning.
      await database.admin.query('insert into managed_knowledge_private.items(id,note,payload,operation_id,work_id,observed_at) values($1,$2,$3,$4,$5,$6)',
        [collisionId,'Fixture collision occupant',{},collision.commit.operationId,collision.commit.workId,MANAGED_TEST_NOW])
      await assert.rejects(active().commitOperations(collision.commit),KnowledgeOperationStaleTargetError)
      assert.equal(await active().findReceipt(collision.commit.operationId),null)
      assert.equal((await database.admin.query('select note from managed_knowledge_private.items where id=$1',[collisionId])).rows[0].note,'Fixture collision occupant')
      const contenderA = await prepare(active(),managedFixture('context-race-a'))
      const contenderB = await prepare(active(),managedFixture('context-race-b'))
      const results = await Promise.allSettled([active().commitOperations(contenderA.commit),active().commitOperations(contenderB.commit)])
      assert.equal(results.filter((result) => result.status === 'fulfilled').length,1)
      const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult
      assert.ok(rejected.reason instanceof KnowledgeOperationStaleTargetError)
    })

    await t.test('corrections create successors; attachments and retractions retain immutable prose/history',async () => {
      const before = (await active().researchContext({itemIds:[acceptedItemId]})).items.find((item) => item.itemId === acceptedItemId)!
      const input = managedFixture('correction')
      const corrected = await prepare(active(),input,{kind:'apply',drafts:[draft(input,'successor')],operations:[{candidateItemRef:acceptedItemId,kind:'correct',payload:{successorLocalKey:'successor',kind:'retract',successorItemId:'model-forgery'}}]})
      await active().commitOperations(corrected.commit)
      const old = (await active().researchContext({itemIds:[acceptedItemId]})).items.find((item) => item.itemId === acceptedItemId)!
      const successor = corrected.commit.expectedAbsentItemIds[0]
      assert.equal(old.note,before.note)
      assert.equal(old.status,'corrected')
      assert.deepEqual(old.successorItemIds,[successor])
      const successorNote = (await active().researchContext({itemIds:[successor]})).items.find((item) => item.itemId === successor)!.note
      const attachmentInput = managedFixture('attachment')
      const attachment = await prepare(active(),attachmentInput,{kind:'apply',drafts:[],operations:[{candidateItemRef:successor,kind:'attach_evidence',payload:{evidenceRefs:[edge(attachmentInput)]}}]})
      await active().commitOperations(attachment.commit)
      const attached = (await active().researchContext({itemIds:[successor]})).items.find((item) => item.itemId === successor)!
      assert.equal(attached.note,successorNote)
      assert.ok(attached.packetRefs.includes('packet-attachment'))
      assert.equal(attached.evidenceRefs.length,2)
      const removal = await prepare(active(),managedFixture('remove-membership'),{kind:'apply',drafts:[],operations:[{candidateItemRef:successor,kind:'remove_membership',payload:{entityId:ACME_ID,reason:'Fixture membership correction'}}]})
      await active().commitOperations(removal.commit)
      const removed = (await active().researchContext({itemIds:[successor]})).items.find((item) => item.itemId === successor)!
      assert.deepEqual(removed.entityIds,[])
      assert.equal(removed.note,successorNote)
      assert.equal((await database.admin.query('select count(*)::int as count from managed_knowledge_private.memberships where item_id=$1 and removed_operation=$2',[successor,removal.commit.operationId])).rows[0].count,1)
      const retraction = await prepare(active(),managedFixture('retract'),{kind:'apply',drafts:[],operations:[{candidateItemRef:successor,kind:'retract',payload:{reason:'Fixture attributable withdrawal'}}]})
      await active().commitOperations(retraction.commit)
      const retracted = (await active().researchContext({itemIds:[successor]})).items.find((item) => item.itemId === successor)!
      assert.equal(retracted.status,'retracted')
      assert.equal(retracted.note,successorNote)
      const history = await database.admin.query('select event_kind from managed_knowledge_private.history where item_id=$1 order by sequence',[successor])
      assert.deepEqual(history.rows.map((row) => row.event_kind),['create','attach_evidence','remove_membership','retract'])
    })

    await t.test('missing grounded subjects creates a durable hold before constructing a paid planner',async () => {
      const input = managedFixture('no-grounded-subject',{name:'Unresolved Subject Fixture',role:'mentioned'})
      let constructions = 0
      const processor = new ManagedCanonicalPacketProcessor({writer:active(),ports:[fixturePort(input)],owner:'no-subject-owner',policyVersion:'fixture',
        assertOwnership(){},executeOwned:(_source,action) => action(),gatewayFactory(){constructions += 1;throw new Error('No paid planner is permitted for an ungrounded subject')}})
      await assert.rejects(processor.process(input),/entity_identity_grounding/)
      const operationId = deriveProgressionOperationId(input.work.workId)
      assert.equal(constructions,0)
      assert.equal(await active().findPlanningDispatch(operationId),null)
      assert.equal(await active().findReceipt(operationId),null)
      const holds = await active().findHoldHistory(operationId)
      assert.equal(holds.length,1)
      assert.equal(holds[0].missingDependency,'entity_identity_grounding')
      assert.equal((await active().findSavedPlanHistory(operationId))[0].plan.outcome.kind,'hold')
    })

    await t.test('identical paid requests reuse validated outcomes across watermark drift and historical A to B to A routes',async () => {
      const input = managedFixture('paid-result-reuse',{name:'Request Replay Company'})
      const operationId = deriveProgressionOperationId(input.work.workId)
      const calledModels: string[] = []
      let model = 'A'
      const processor = new ManagedCanonicalPacketProcessor({writer:active(),ports:[fixturePort(input)],owner:'reuse-owner',policyVersion:'fixture',
        assertOwnership(){},executeOwned:(_source,action) => action(),gatewayFactory:() => ({
          resolveRoute:() => ({primary:{provider:'fixture',model}}),
          async generateStructured<T>(request: GenerateStructuredRequest<T>) {
            const prompt = JSON.parse(request.prompt.split('\n').at(-1)!)
            assert.equal(prompt.entityCandidates.length,1,'The paid reuse case must have a grounded provisional identity')
            assert.equal(prompt.entityCandidates[0].revision,'absent')
            calledModels.push(model)
            return {value:{kind:'hold',reason:`Retain known result from ${model}`,missingDependency:'fixture_context_resolution'} as T,telemetry:MOCK_TELEMETRY}
          },
        })})
      await assert.rejects(processor.process(input),/fixture_context_resolution/)
      const firstDispatch = await active().findPlanningDispatch(operationId)
      assert.equal(firstDispatch?.state,'settled')
      const advanceWatermark = async (suffix: string) => {
        const unrelated = await prepare(active(),managedFixture(suffix))
        await active().commitOperations(unrelated.commit)
        await active().releaseLease(unrelated.lease.operationId,unrelated.lease.owner,unrelated.lease.epoch)
      }
      await advanceWatermark('replay-watermark-one')
      await assert.rejects(processor.process(input),/fixture_context_resolution/)
      assert.deepEqual(calledModels,['A'],'Unrelated context watermark changes must not purchase the same prompt again')
      const repeatedPlans = await active().findSavedPlanHistory(operationId)
      assert.equal(repeatedPlans.length,2)
      assert.notEqual(repeatedPlans[0].attemptDigest,repeatedPlans[1].attemptDigest)
      assert.notEqual(repeatedPlans[0].plan.contextWatermark,repeatedPlans[1].plan.contextWatermark)
      assert.equal((await active().findPlanningDispatch(operationId))?.requestDigest,firstDispatch!.requestDigest)

      await advanceWatermark('replay-watermark-two')
      model = 'B'
      await assert.rejects(processor.process(input),/fixture_context_resolution/)
      assert.deepEqual(calledModels,['A','B'],'A meaningfully changed actual request remains eligible for one bounded dispatch')
      const secondDispatch = await active().findPlanningDispatch(operationId)
      assert.notEqual(secondDispatch?.requestDigest,firstDispatch!.requestDigest)
      await advanceWatermark('replay-watermark-three')
      model = 'A'
      await assert.rejects(processor.process(input),/Retain known result from A/)
      assert.deepEqual(calledModels,['A','B'],'An older matching paid request must be found behind the latest different route')

      // A later supported non-execution receipt must not hide an older paid
      // result for the same immutable request. This is isolated mocked proof.
      const latestPlan = (await active().findSavedPlanHistory(operationId)).at(-1)!
      const {contractVersion:_version,operationId:_operation,workId:_work,outcome:_outcome,...previousMetadata} = latestPlan.plan
      const metadata = {...previousMetadata,contextDigest:'d'.repeat(64)}
      const lease = await active().acquireLease(operationId,'reuse-owner')
      assert.ok(lease)
      const reserved = await active().reservePlanningDispatch({operationId,workId:input.work.workId,owner:lease.owner,epoch:lease.epoch,metadata,
        requestDigest:firstDispatch!.requestDigest!,providerRoute:{primary:{provider:'fixture',model:'A'}}})
      assert.equal(reserved.reserved,true)
      await active().releaseLease(operationId,lease.owner,lease.epoch)
      await active().resolvePlanningDispatch({operationId,attemptDigest:deriveProgressionAttemptDigest(operationId,metadata),requestDigest:firstDispatch!.requestDigest!,
        resolution:'confirmed_no_execution',proof:{source:'provider_execution_record',provider:'fixture',proofRef:'fixture://supported/no-execution',proofDigest:'b'.repeat(64),confirmedBy:'fixture-operator'}})
      const recorded = await active().findRecordedPlanningRequest(operationId,firstDispatch!.requestDigest!)
      assert.equal(recorded?.dispatch.attemptDigest,firstDispatch!.attemptDigest)
      assert.equal(recorded?.plan?.plan.outcome.kind,'hold')
      assert.equal(await active().findReceipt(operationId),null,'Saved semantic holds must not become accepted facts during reuse')
    })

    await t.test('a returned invalid planning result stays retained and cannot be repurchased or accepted',async () => {
      const input = managedFixture('rejected-result-no-rebuy',{name:'Rejected Result Company'})
      let calls = 0
      const processor = (policyVersion: string) => new ManagedCanonicalPacketProcessor({writer:active(),ports:[fixturePort(input)],owner:'invalid-result-owner',policyVersion,
        assertOwnership(){},executeOwned:(_source,action) => action(),gatewayFactory:() => ({resolveRoute:() => ({primary:{provider:'fixture'}}),async generateStructured<T>() {
          calls += 1
          return {value:{kind:'apply',drafts:[draft(input)],operations:[]} as T,telemetry:MOCK_TELEMETRY}
        }})})
      await assert.rejects(processor('fixture-one').process(input),/unresolved identity blocks apply/)
      const operationId = deriveProgressionOperationId(input.work.workId)
      const dispatch = await active().findPlanningDispatch(operationId)
      assert.equal(dispatch?.state,'held')
      const recorded = await active().findRecordedPlanningRequest(operationId,dispatch!.requestDigest!)
      assert.equal(recorded?.plan,null)
      await assert.rejects(processor('changed-policy').process(input),/remains unresolved/)
      assert.equal(calls,1)
      assert.equal(await active().findReceipt(operationId),null)
      assert.equal((await active().findSavedPlanHistory(operationId)).length,0)
      const holds = await active().findHoldHistory(operationId)
      assert.equal(holds.length,1)
      assert.equal(holds[0].missingDependency,'plan_validation')
      assert.equal((holds[0].retainedPayload as {outcome:{kind:string}}).outcome.kind,'apply')
    })

    await t.test('unknown paid planning outcome stays held across changed attempts until bound reconciliation',async () => {
      const input = managedFixture('unknown')
      let calls = 0
      const processor = (policyVersion: string) => new ManagedCanonicalPacketProcessor({writer:active(),ports:[fixturePort(input)],owner:'unknown-owner',policyVersion,
        assertOwnership(){},executeOwned:(_source,action) => action(),gatewayFactory:() => ({resolveRoute:() => ({primary:{provider:'fixture'}}),async generateStructured(){calls += 1;throw new Error('mock transport loss after paid dispatch')}})})
      await assert.rejects(processor('first-policy').process(input),/operator reconciliation/)
      await assert.rejects(processor('changed-policy').process(input),/remains unresolved/)
      assert.equal(calls,1)
      const operationId = deriveProgressionOperationId(input.work.workId)
      const dispatch = await active().findPlanningDispatch(operationId)
      assert.equal(dispatch?.state,'held')
      assert.equal(await active().findReceipt(operationId),null)
      assert.equal((await active().findHoldHistory(operationId)).length,1)
      const proof = {source:'provider_execution_record' as const,provider:'fixture',proofRef:'fixture://provider/nonexecution',proofDigest:'b'.repeat(64),confirmedBy:'fixture-operator'}
      const direct = database.pool('v4_writer_fixture')
      try {
        await assert.rejects(direct.query('select managed_knowledge_private.writer_v1($1,$2::jsonb)',['resolve_plan_dispatch',{
          operationId,attemptDigest:dispatch!.attemptDigest,requestDigest:dispatch!.requestDigest,resolution:'confirmed_no_execution',proof:{...proof,proofDigest:null},
        }]),(error:unknown) => (error as {code?:string}).code === '22023')
      } finally {await direct.end()}
      await assert.rejects(active().resolvePlanningDispatch({operationId,attemptDigest:dispatch!.attemptDigest,requestDigest:'a'.repeat(64),resolution:'confirmed_no_execution',proof}),KnowledgeOperationConflictError)
      await assert.rejects(active().resolvePlanningDispatch({operationId,attemptDigest:dispatch!.attemptDigest,requestDigest:dispatch!.requestDigest!,resolution:'confirmed_no_execution',proof:{...proof,provider:'other-provider'}}),KnowledgeOperationConflictError)
      await active().resolvePlanningDispatch({operationId,attemptDigest:dispatch!.attemptDigest,requestDigest:dispatch!.requestDigest!,resolution:'confirmed_no_execution',proof})
      assert.equal((await active().findPlanningDispatch(operationId,dispatch!.attemptDigest))?.state,'resolved_without_execution')
      const events = await database.admin.query('select state,proof from managed_knowledge_private.planning_dispatch_events where operation_id=$1 order by sequence',[operationId])
      assert.ok(events.rows.some((row) => row.state === 'held'))
      assert.equal(events.rows.at(-1)?.proof.confirmedBy,'fixture-operator')
    })

    await t.test('crash after planning reservation blocks new attempts and unbound provider reconciliation',async () => {
      const input = managedFixture('dispatch-crash')
      const prepared = await prepare(active(),input)
      const requestDigest = 'c'.repeat(64)
      assert.equal((await active().reservePlanningDispatch({operationId:prepared.commit.operationId,workId:input.work.workId,owner:prepared.lease.owner,epoch:prepared.lease.epoch,metadata:prepared.metadata,requestDigest,providerRoute:{workload:'entity.extract'}})).reserved,true)
      await active().releaseLease(prepared.lease.operationId,prepared.lease.owner,prepared.lease.epoch)
      let calls = 0
      const processor = new ManagedCanonicalPacketProcessor({writer:active(),ports:[fixturePort(input)],owner:'restarted-worker',policyVersion:'new-policy-after-crash',assertOwnership(){},executeOwned:(_source,action) => action(),
        gatewayFactory:() => ({resolveRoute:() => ({primary:{provider:'fixture'}}),async generateStructured(){calls += 1;throw new Error('must not purchase after crash')}})})
      await assert.rejects(processor.process(input),/reconcile provider execution/)
      assert.equal(calls,0)
      assert.equal((await active().findPlanningDispatch(prepared.commit.operationId))?.state,'held')
      await assert.rejects(active().resolvePlanningDispatch({operationId:prepared.commit.operationId,attemptDigest:prepared.saved.attemptDigest,requestDigest,resolution:'confirmed_no_execution',
        proof:{source:'provider_execution_record',provider:'unbound-provider',proofRef:'fixture://unsupported-lookup',proofDigest:'d'.repeat(64),confirmedBy:'fixture-operator'}}),KnowledgeOperationConflictError)
    })

    await t.test('actual managed planner accepts approved partial, code-owned private identities and secondary memberships',async () => {
      const input = managedFixture('partial-new',{partial:true,name:'New Grounded Company'})
      input.canonicalPacket.claims[0].claim = 'New Grounded Company and Fixture Regulator both described the project.'
      input.canonicalPacket.entityHints.push({...input.canonicalPacket.entityHints[0],name:'Fixture Regulator',role:'regulator'})
      // Reassess against the exact edited saved packet; readiness stays Research-owned.
      const {assessResearchReadiness} = await import('../signal-platform/research-readiness')
      input.handoffContext.readiness = assessResearchReadiness({work:input.work,signal:input.handoffContext.signal,packet:input.canonicalPacket,persistedEvidence:input.handoffContext.persistedEvidence,assessedAt:MANAGED_TEST_NOW})
      let calls = 0
      const processor = new ManagedCanonicalPacketProcessor({writer:active(),ports:[fixturePort(input)],owner:'partial-owner',policyVersion:'fixture',assertOwnership(){},executeOwned:(_source,action) => action(),
        gatewayFactory:() => ({resolveRoute:() => ({primary:{provider:'fixture'}}),async generateStructured<T>(request: GenerateStructuredRequest<T>){
          calls += 1
          assert.equal(request.holdOnUnknownOutcome,true)
          const prompt = JSON.parse(request.prompt.split('\n').at(-1)!)
          const proposal = {kind:'apply',drafts:[{...draft(input),entityLinks:prompt.entityCandidates.map((entity:{id:string}) => ({candidateEntityRef:entity.id,role:'participant'}))}],operations:[]}
          return {value:proposal as T,telemetry:MOCK_TELEMETRY}
        }})})
      assert.equal((await processor.process(input)).memoryOutcome,'written')
      assert.equal(calls,1)
      const result = await active().researchContext({source:'news',sourceRefs:['native-partial-new']})
      assert.equal(result.entities.length,2)
      assert.equal(result.items.length,1)
      assert.equal(result.items[0].entityIds.length,2)
      assert.match(result.items[0].note,/Research contribution is partial/)
      assert.match(result.items[0].note,/not been independently verified/)
      assert.equal((await database.admin.query("select count(*)::int as count from public.entities where name in ('New Grounded Company','Fixture Regulator')")).rows[0].count,0)
      const packetRefs = result.items[0].packetRefs
      assert.deepEqual(packetRefs,['packet-partial-new'])

      const owed = managedFixture('owed-attachment')
      owed.handoffContext.readiness = createResolvedWithoutNewItemReadiness({work:owed.work,signal:owed.handoffContext.signal,packet:owed.canonicalPacket,
        persistedEvidence:owed.handoffContext.persistedEvidence,assessedAt:MANAGED_TEST_NOW,reason:'Existing managed item owes exact evidence attachment',
        owedAttachment:{targetId:result.items[0].itemId}})
      const deterministic = new ManagedCanonicalPacketProcessor({writer:active(),ports:[fixturePort(owed)],owner:'attachment-owner',policyVersion:'fixture',assertOwnership(){},executeOwned:(_source,action) => action(),gatewayFactory(){throw new Error('owed attachment must not purchase prose')}})
      assert.equal((await deterministic.process(owed)).memoryOutcome,'written')
      const attached = (await active().researchContext({itemIds:[result.items[0].itemId]})).items.find((item) => item.itemId === result.items[0].itemId)!
      assert.equal(attached.note,result.items[0].note)
      assert.equal(attached.evidenceRefs.length,2)
    })

    await t.test('isolated server restart preserves terminal receipts and legacy sentinel/index',async () => {
      await writer!.close()
      writer = undefined
      await database.restart()
      writer = database.writer()
      assert.equal((await writer.findReceipt(accepted.commit.operationId))?.status,'accepted')
      assert.equal((await writer.findSavedPlanHistory(accepted.commit.operationId)).length,1)
      const sentinel = await database.admin.query('select note from public.entity_memories')
      assert.equal(sentinel.rows[0].note,'legacy fixture must remain untouched')
      const index = await database.admin.query("select to_regclass('public.entity_memories_legacy_fixture_idx') as name")
      assert.equal(index.rows[0].name,'entity_memories_legacy_fixture_idx')
      const status = await writer.readOperationalStatus('news')
      assert.equal(status.source,'news')
      assert.ok(status.receipts >= 5)
      assert.ok(status.holds >= 2)
      assert.ok(status.unresolvedPlanningDispatches >= 1)
      assert.ok(!('note' in status) && !('packet' in status))
    })
  } finally {
    if (writer) await writer.close()
    await database.close()
  }
})
