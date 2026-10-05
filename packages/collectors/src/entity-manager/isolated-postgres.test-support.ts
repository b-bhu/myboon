import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Pool } from 'pg'
import { PostgresKnowledgeOperationWriter, type ManagedKnowledgeWriterOptions } from './postgres-knowledge-writer'

const DATABASE = 'myboon_entity_v4_validation'
const IMAGE = 'postgres:17.11'
const PASSWORD = 'isolated_fixture_only'

/** Never accepts a database URL or existing container from the environment. */
export class IsolatedEntityPostgres {
  readonly name = `myboon-v4-entity-${randomUUID().slice(0,8)}`
  readonly directory = mkdtempSync(join(tmpdir(),'myboon-v4-entity-'))
  readonly network = `${this.name}-network`
  get ca(): string { return readFileSync(join(this.directory,'server.crt'),'utf8') }
  port = 0
  private host = ''
  admin!: Pool
  private readonly dockerPrefix: string[]
  private containerCreated = false
  private networkCreated = false

  constructor() {
    const direct = spawnSync('docker',['info','--format','{{.ServerVersion}}'],{encoding:'utf8'})
    this.dockerPrefix = direct.status === 0 ? [] : ['-n','docker']
    chmodSync(this.directory,0o755)
  }

  async start(): Promise<void> {
    this.docker(['image','inspect',IMAGE,'--format','{{.Id}}'])
    this.docker(['network','create','--internal','--label','myboon.fixture=entity-v4',this.network])
    this.networkCreated = true
    const networkInspection = JSON.parse(this.docker(['network','inspect',this.network]))[0]
    assert.equal(networkInspection.Internal,true)
    this.host = networkInspection.IPAM.Config[0].Gateway.replace(/\.[0-9]+$/,'.2')
    execFileSync('openssl',['req','-x509','-nodes','-newkey','rsa:2048','-days','1','-subj','/CN=localhost',
      '-addext',`subjectAltName=DNS:localhost,IP:127.0.0.1,IP:${this.host}`,'-keyout',join(this.directory,'server.key'),'-out',join(this.directory,'server.crt')],{stdio:'ignore'})
    // The certificate is public material and must remain readable by the
    // container's postgres UID even when the operator uses private umask 077.
    chmodSync(join(this.directory,'server.crt'),0o644)
    chmodSync(join(this.directory,'server.key'),0o600)
    execFileSync('sudo',['-n','chown','999:999',join(this.directory,'server.key')])
    this.docker(['run','--detach','--name',this.name,'--label','myboon.fixture=entity-v4','--network',this.network,
      '--ip',this.host,'--mount',`type=bind,src=${this.directory},dst=/fixture,readonly`,
      '--env',`POSTGRES_PASSWORD=${PASSWORD}`,'--env',`POSTGRES_DB=${DATABASE}`,IMAGE,
      '-c','ssl=on','-c','ssl_cert_file=/fixture/server.crt','-c','ssl_key_file=/fixture/server.key','-c','log_min_messages=warning'])
    this.containerCreated = true
    const inspection = JSON.parse(this.docker(['inspect',this.name]))[0]
    assert.equal(inspection.Config.Labels['myboon.fixture'],'entity-v4')
    assert.deepEqual(Object.keys(inspection.NetworkSettings.Networks),[this.network])
    assert.ok(!inspection.HostConfig.PortBindings || Object.keys(inspection.HostConfig.PortBindings).length === 0)
    assert.equal(inspection.NetworkSettings.Networks[this.network].IPAddress,this.host)
    assert.equal(inspection.Mounts.filter((value: { Type: string }) => value.Type === 'bind').length,1)
    this.port = 5432
    this.admin = this.pool('postgres')
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const result = await this.admin.query('select current_database() as db, (select ssl from pg_stat_ssl where pid=pg_backend_pid()) as tls')
        assert.deepEqual(result.rows[0],{db:DATABASE,tls:true})
        return
      } catch (error) {
        if (attempt === 99) {writeFileSync(join(this.directory,'startup.log'),this.docker(['logs',this.name]));throw error}
        await new Promise((resolvePromise) => setTimeout(resolvePromise,100))
      }
    }
  }

  async migrate(options: {nonSuperuserAdmin?:boolean;preexistingMinimalRoles?:boolean;existingElevatedRole?:'login'|'bypass_rls'|'membership'} = {}): Promise<void> {
    const baseline = readFileSync(resolve(__dirname,'../../../../supabase/migrations/20260624_entity_manager_v1.sql'),'utf8')
      .split('CREATE TABLE IF NOT EXISTS public.entity_memories')[0]
    await this.admin.query(`
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN; CREATE ROLE authenticator NOLOGIN;
      ${baseline}
      ALTER TABLE public.entities ENABLE ROW LEVEL SECURITY;
      CREATE TABLE public.entity_memories(id uuid PRIMARY KEY,note text NOT NULL);
      CREATE INDEX entity_memories_legacy_fixture_idx ON public.entity_memories(note);
      INSERT INTO public.entity_memories VALUES('22222222-2222-2222-2222-222222222222','legacy fixture must remain untouched');
      INSERT INTO public.entities(id,slug,name,type,aliases) VALUES('11111111-1111-1111-1111-111111111111','acme','Acme','organization','["ACME"]');
    `)
    let migrationPool = this.admin
    if (options.nonSuperuserAdmin) {
      await this.admin.query(`
        CREATE ROLE fixture_deployer LOGIN PASSWORD '${PASSWORD}' NOSUPERUSER CREATEROLE CREATEDB BYPASSRLS REPLICATION;
        GRANT CREATE ON DATABASE ${DATABASE} TO fixture_deployer;
        GRANT USAGE,CREATE ON SCHEMA public TO fixture_deployer;
        ALTER TABLE public.entities OWNER TO fixture_deployer;
        ALTER TABLE public.entity_memories OWNER TO fixture_deployer;
        GRANT anon,authenticated,service_role,authenticator TO fixture_deployer WITH ADMIN OPTION;
      `)
      migrationPool = this.pool('fixture_deployer')
    }
    if (options.preexistingMinimalRoles) {
      await migrationPool.query('CREATE ROLE myboon_knowledge_owner NOLOGIN;CREATE ROLE myboon_knowledge_executor NOLOGIN;CREATE ROLE myboon_knowledge_context_executor NOLOGIN;')
    }
    if (options.existingElevatedRole) {
      await this.admin.query(`CREATE ROLE myboon_knowledge_owner ${options.existingElevatedRole === 'login' ? 'LOGIN':'NOLOGIN'} ${options.existingElevatedRole === 'bypass_rls' ? 'BYPASSRLS':'NOBYPASSRLS'};`)
      if (options.existingElevatedRole === 'membership') await this.admin.query('GRANT service_role TO myboon_knowledge_owner')
    }
    const migration = readFileSync(resolve(__dirname,'../../../../supabase/migrations/20261003090000_entity_manager_v4_private_knowledge.sql'),'utf8')
    const connection = await migrationPool.connect()
    try {
      await connection.query('BEGIN')
      await connection.query(migration)
      await connection.query('COMMIT')
    } catch (error) {
      await connection.query('ROLLBACK')
      throw error
    } finally { connection.release();if (migrationPool !== this.admin) await migrationPool.end() }
    await this.admin.query(`
      CREATE ROLE v4_writer_fixture LOGIN PASSWORD '${PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
      GRANT myboon_knowledge_executor TO v4_writer_fixture;
      CREATE ROLE v4_reader_fixture LOGIN PASSWORD '${PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
      GRANT myboon_knowledge_context_executor TO v4_reader_fixture;
      CREATE ROLE v4_api_fixture LOGIN PASSWORD '${PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
      GRANT service_role TO v4_api_fixture;
    `)
  }

  writer(): PostgresKnowledgeOperationWriter {
    return new PostgresKnowledgeOperationWriter(this.writerOptions())
  }

  writerOptions(): ManagedKnowledgeWriterOptions {return {connectionString:this.url('v4_writer_fixture'),ca:this.ca}}

  pool(username: string): Pool {
    return new Pool({connectionString:this.url(username),ssl:{ca:this.ca,rejectUnauthorized:true},connectionTimeoutMillis:1500,max:4})
  }

  async restart(): Promise<void> {
    await this.admin.end()
    this.docker(['restart',this.name])
    this.admin = this.pool('postgres')
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try { await this.admin.query('select 1'); return } catch (error) {
        if (attempt === 49) throw error
        await new Promise((resolvePromise) => setTimeout(resolvePromise,100))
      }
    }
  }

  async close(): Promise<void> {
    if (this.admin) await this.admin.end().catch(() => {})
    if (this.containerCreated) {
      const result = spawnSync(this.dockerPrefix.length ? 'sudo':'docker',[...this.dockerPrefix,'logs',this.name],{encoding:'utf8'})
      writeFileSync(join(this.directory,'server.log'),result.stdout + result.stderr)
      this.docker(['rm','--force','--volumes',this.name])
    }
    if (this.networkCreated) this.docker(['network','rm',this.network])
    // Keep only task-owned TLS/log artifacts under /tmp for this validation.
  }

  private url(username: string): string {
    assert.ok(this.port > 0)
    return `postgresql://${username}:${PASSWORD}@${this.host}:${this.port}/${DATABASE}`
  }

  private docker(args: string[]): string {
    return execFileSync(this.dockerPrefix.length ? 'sudo' : 'docker',[...this.dockerPrefix,...args],{encoding:'utf8',timeout:60_000})
  }
}
