-- #299 private Entity V4 storage. Additive only: legacy entities, memories,
-- compatibility triggers and indexes are never rewritten or exposed here.
-- Provision a dedicated LOGIN separately, then GRANT myboon_knowledge_executor
-- TO that login. Research-only logins receive myboon_knowledge_context_executor.
-- Do not grant either role to authenticator, service_role or browser roles.

DO $roles$
DECLARE
  private_role text;
  existing_role pg_catalog.pg_roles;
BEGIN
  FOREACH private_role IN ARRAY ARRAY['myboon_knowledge_owner','myboon_knowledge_executor','myboon_knowledge_context_executor'] LOOP
    SELECT * INTO existing_role FROM pg_catalog.pg_roles WHERE rolname = private_role;
    IF FOUND THEN
      -- Never demote or adopt an unrelated privileged/login role. In particular,
      -- Supabase postgres cannot ALTER the SUPERUSER property even to false.
      IF existing_role.rolcanlogin OR existing_role.rolsuper OR existing_role.rolbypassrls
        OR existing_role.rolcreatedb OR existing_role.rolcreaterole OR existing_role.rolreplication
        OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = existing_role.oid) THEN
        RAISE EXCEPTION 'existing managed role % must be an isolated minimal NOLOGIN role',private_role USING ERRCODE = '42501';
      END IF;
    ELSE
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION',private_role);
    END IF;
  END LOOP;
END
$roles$;

CREATE SCHEMA managed_knowledge_private;
REVOKE ALL ON SCHEMA managed_knowledge_private FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA managed_knowledge_private TO myboon_knowledge_owner, myboon_knowledge_executor, myboon_knowledge_context_executor;
ALTER DEFAULT PRIVILEGES IN SCHEMA managed_knowledge_private REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA managed_knowledge_private REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE managed_knowledge_private.sources (
  work_id text PRIMARY KEY CHECK (length(work_id) BETWEEN 1 AND 1000),
  packet_digest text NOT NULL CHECK (packet_digest ~ '^[0-9a-f]{64}$'),
  packet jsonb NOT NULL,
  readiness jsonb NOT NULL,
  readiness_digest text NOT NULL CHECK (readiness_digest ~ '^[0-9a-f]{64}$'),
  source text NOT NULL CHECK (source IN ('news','polymarket')),
  source_refs jsonb NOT NULL CHECK (jsonb_typeof(source_refs) = 'array' AND jsonb_array_length(source_refs) <= 32),
  retrieved_evidence jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (octet_length(packet::text) <= 8388608)
);
CREATE INDEX managed_sources_native_refs ON managed_knowledge_private.sources USING gin(source_refs);

CREATE TABLE managed_knowledge_private.planning_contexts (
  work_id text NOT NULL REFERENCES managed_knowledge_private.sources(work_id),
  context_digest text NOT NULL CHECK (context_digest ~ '^[0-9a-f]{64}$'),
  watermark bigint NOT NULL CHECK (watermark >= 0),
  entities jsonb NOT NULL CHECK (jsonb_typeof(entities) = 'array' AND jsonb_array_length(entities) <= 32),
  item_revisions jsonb NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (work_id, context_digest)
);
CREATE TABLE managed_knowledge_private.leases (
  operation_id text PRIMARY KEY CHECK (operation_id ~ '^progression-v2:[0-9a-f]{64}$'),
  owner text NOT NULL CHECK (length(owner) BETWEEN 1 AND 1000),
  epoch bigint NOT NULL CHECK (epoch > 0),
  expires_at timestamptz NOT NULL
);
CREATE TABLE managed_knowledge_private.plans (
  operation_id text NOT NULL REFERENCES managed_knowledge_private.leases(operation_id),
  revision integer NOT NULL CHECK (revision > 0),
  attempt_digest text NOT NULL CHECK (attempt_digest ~ '^[0-9a-f]{64}$'),
  plan_digest text NOT NULL CHECK (plan_digest ~ '^[0-9a-f]{64}$'),
  plan jsonb NOT NULL,
  effects jsonb NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (operation_id, revision),
  CHECK (octet_length(plan::text) <= 1048576)
);
CREATE INDEX managed_plan_attempt ON managed_knowledge_private.plans(operation_id, attempt_digest, revision DESC);
CREATE TABLE managed_knowledge_private.planning_dispatches (
  operation_id text NOT NULL REFERENCES managed_knowledge_private.leases(operation_id),
  work_id text NOT NULL REFERENCES managed_knowledge_private.sources(work_id),
  attempt_digest text NOT NULL CHECK (attempt_digest ~ '^[0-9a-f]{64}$'),
  owner_epoch bigint NOT NULL,
  request_digest text NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),
  provider_route jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('dispatched','settled','held','resolved_without_execution')),
  dispatched_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(operation_id,attempt_digest)
);
CREATE TABLE managed_knowledge_private.planning_dispatch_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operation_id text NOT NULL,
  attempt_digest text NOT NULL,
  state text NOT NULL,
  proof jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(operation_id,attempt_digest) REFERENCES managed_knowledge_private.planning_dispatches(operation_id,attempt_digest)
);
CREATE TABLE managed_knowledge_private.holds (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operation_id text NOT NULL REFERENCES managed_knowledge_private.leases(operation_id),
  owner_epoch bigint NOT NULL,
  attempt_digest text NOT NULL,
  plan_revision integer,
  plan_digest text NOT NULL,
  content_digest text NOT NULL,
  receipt jsonb NOT NULL CHECK (receipt->>'status' = 'held'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (octet_length(receipt::text) <= 8388608)
);
CREATE UNIQUE INDEX managed_hold_idempotence ON managed_knowledge_private.holds
  (operation_id, owner_epoch, attempt_digest, coalesce(plan_revision,0), plan_digest, content_digest);
CREATE TABLE managed_knowledge_private.receipts (
  operation_id text PRIMARY KEY REFERENCES managed_knowledge_private.leases(operation_id),
  work_id text NOT NULL REFERENCES managed_knowledge_private.sources(work_id),
  plan_revision integer NOT NULL,
  plan_digest text NOT NULL,
  content_digest text NOT NULL,
  receipt jsonb NOT NULL CHECK (receipt->>'status' = 'accepted'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (operation_id, plan_revision) REFERENCES managed_knowledge_private.plans(operation_id, revision)
);
CREATE TABLE managed_knowledge_private.entities (
  id uuid PRIMARY KEY,
  identity_key text NOT NULL UNIQUE,
  catalog_entity_id uuid REFERENCES public.entities(id),
  binding jsonb NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  created_operation text NOT NULL REFERENCES managed_knowledge_private.leases(operation_id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE managed_knowledge_private.items (
  id uuid PRIMARY KEY,
  note text NOT NULL CHECK (length(btrim(note)) BETWEEN 1 AND 6000),
  payload jsonb NOT NULL,
  operation_id text NOT NULL REFERENCES managed_knowledge_private.leases(operation_id),
  work_id text NOT NULL REFERENCES managed_knowledge_private.sources(work_id),
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE managed_knowledge_private.item_heads (
  item_id uuid PRIMARY KEY REFERENCES managed_knowledge_private.items(id),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','corrected','superseded','retracted'))
);
CREATE TABLE managed_knowledge_private.memberships (
  item_id uuid NOT NULL REFERENCES managed_knowledge_private.items(id),
  entity_id uuid NOT NULL REFERENCES managed_knowledge_private.entities(id),
  role text NOT NULL CHECK (length(role) BETWEEN 1 AND 1000),
  added_operation text NOT NULL REFERENCES managed_knowledge_private.leases(operation_id),
  removed_operation text REFERENCES managed_knowledge_private.leases(operation_id),
  PRIMARY KEY (item_id, entity_id)
);
CREATE INDEX managed_memberships_entity ON managed_knowledge_private.memberships(entity_id,item_id);
CREATE TABLE managed_knowledge_private.item_sources (
  item_id uuid NOT NULL REFERENCES managed_knowledge_private.items(id),
  work_id text NOT NULL REFERENCES managed_knowledge_private.sources(work_id),
  operation_id text NOT NULL REFERENCES managed_knowledge_private.leases(operation_id),
  PRIMARY KEY (item_id,work_id)
);
CREATE TABLE managed_knowledge_private.evidence (
  item_id uuid NOT NULL REFERENCES managed_knowledge_private.items(id),
  work_id text NOT NULL REFERENCES managed_knowledge_private.sources(work_id),
  claim_id text NOT NULL,
  evidence_id text NOT NULL,
  source_ref text NOT NULL,
  claim jsonb NOT NULL,
  evidence jsonb NOT NULL,
  operation_id text NOT NULL REFERENCES managed_knowledge_private.leases(operation_id),
  PRIMARY KEY (item_id,work_id,claim_id,evidence_id)
);
CREATE TABLE managed_knowledge_private.developments (
  from_item uuid NOT NULL REFERENCES managed_knowledge_private.items(id),
  to_item uuid NOT NULL REFERENCES managed_knowledge_private.items(id),
  kind text NOT NULL CHECK (length(kind) BETWEEN 1 AND 1000),
  operation_id text NOT NULL REFERENCES managed_knowledge_private.leases(operation_id),
  CHECK (from_item <> to_item),
  PRIMARY KEY (from_item,to_item,kind)
);
CREATE TABLE managed_knowledge_private.history (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operation_id text NOT NULL REFERENCES managed_knowledge_private.leases(operation_id),
  work_id text NOT NULL REFERENCES managed_knowledge_private.sources(work_id),
  item_id uuid REFERENCES managed_knowledge_private.items(id),
  event_kind text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- The definer does not own tables and cannot bypass RLS or remove records.
DO $policies$
DECLARE relation text;
BEGIN
  FOR relation IN SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'managed_knowledge_private' LOOP
    EXECUTE format('ALTER TABLE managed_knowledge_private.%I ENABLE ROW LEVEL SECURITY', relation);
    EXECUTE format('ALTER TABLE managed_knowledge_private.%I FORCE ROW LEVEL SECURITY', relation);
    EXECUTE format('CREATE POLICY owner_only ON managed_knowledge_private.%I TO myboon_knowledge_owner USING (true) WITH CHECK (true)', relation);
    EXECUTE format('GRANT SELECT, INSERT ON managed_knowledge_private.%I TO myboon_knowledge_owner', relation);
  END LOOP;
END
$policies$;
GRANT UPDATE ON managed_knowledge_private.leases, managed_knowledge_private.item_heads, managed_knowledge_private.memberships, managed_knowledge_private.planning_dispatches TO myboon_knowledge_owner;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA managed_knowledge_private TO myboon_knowledge_owner;
GRANT USAGE ON SCHEMA public TO myboon_knowledge_owner;
GRANT SELECT (id,slug,name,type,aliases,summary,status,metadata,created_at,updated_at) ON public.entities TO myboon_knowledge_owner;
-- PostgreSQL requires UPDATE on at least one column for FOR SHARE row locks.
-- The NOLOGIN owner has only this one audit column, and no writer action ever
-- updates it. Dedicated LOGINs have no direct catalogue privileges.
GRANT UPDATE(updated_at) ON public.entities TO myboon_knowledge_owner;
CREATE POLICY entity_v4_private_catalog_lookup ON public.entities FOR SELECT TO myboon_knowledge_owner USING (true);
CREATE POLICY entity_v4_private_catalog_lock ON public.entities FOR UPDATE TO myboon_knowledge_owner USING (true) WITH CHECK (false);

CREATE FUNCTION managed_knowledge_private.canonical_json_v1(value jsonb, depth integer DEFAULT 0)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $canonical$
DECLARE result text;
BEGIN
  IF depth > 32 THEN RAISE EXCEPTION 'managed JSON depth exceeds bound' USING ERRCODE = '22023'; END IF;
  CASE jsonb_typeof(value)
    WHEN 'object' THEN
      SELECT '{' || coalesce(string_agg(to_jsonb(key)::text || ':' || managed_knowledge_private.canonical_json_v1(item,depth+1), ',' ORDER BY key COLLATE "C"),'') || '}'
        INTO result FROM jsonb_each(value) AS fields(key,item);
    WHEN 'array' THEN
      SELECT '[' || coalesce(string_agg(managed_knowledge_private.canonical_json_v1(item,depth+1), ',' ORDER BY ordinal),'') || ']'
        INTO result FROM jsonb_array_elements(value) WITH ORDINALITY AS elements(item,ordinal);
    ELSE result := value::text;
  END CASE;
  RETURN result;
END
$canonical$;
CREATE FUNCTION managed_knowledge_private.digest_v1(value jsonb)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $digest$
  SELECT encode(sha256(convert_to(managed_knowledge_private.canonical_json_v1(value),'UTF8')),'hex')
$digest$;
CREATE FUNCTION managed_knowledge_private.entity_revision_v1(target uuid)
RETURNS text LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $revision$
DECLARE private_row managed_knowledge_private.entities; catalog_json jsonb; suffix text := '';
BEGIN
  SELECT * INTO private_row FROM managed_knowledge_private.entities WHERE id = target;
  SELECT jsonb_build_object('id',id,'slug',slug,'name',name,'type',type,'aliases',aliases,'summary',summary,'status',status,'metadata',metadata,'updated_at',updated_at)
    INTO catalog_json FROM public.entities WHERE id = coalesce(private_row.catalog_entity_id,target);
  IF catalog_json IS NOT NULL THEN
    IF catalog_json->>'status' <> 'active' THEN RETURN 'unavailable'; END IF;
    suffix := managed_knowledge_private.digest_v1(catalog_json);
  END IF;
  IF private_row.id IS NOT NULL THEN RETURN 'managed:' || private_row.revision::text || ':' || suffix; END IF;
  IF catalog_json IS NOT NULL THEN RETURN 'catalog:' || suffix; END IF;
  RETURN 'absent';
END
$revision$;
CREATE FUNCTION managed_knowledge_private.targets_current_v1(revisions jsonb, watermark text)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $targets$
DECLARE entry record; actual text;
BEGIN
  IF jsonb_typeof(revisions) <> 'object' OR (SELECT count(*) FROM jsonb_object_keys(revisions)) > 32 THEN RETURN false; END IF;
  IF watermark IS NOT NULL AND watermark <> (SELECT coalesce(max(sequence),0)::text FROM managed_knowledge_private.history) THEN RETURN false; END IF;
  FOR entry IN SELECT key,value FROM jsonb_each_text(revisions) ORDER BY key LOOP
    SELECT 'item:' || revision::text INTO actual FROM managed_knowledge_private.item_heads WHERE item_id = entry.key::uuid;
    IF actual IS NULL THEN actual := managed_knowledge_private.entity_revision_v1(entry.key::uuid); END IF;
    IF actual IS DISTINCT FROM entry.value THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END
$targets$;

-- This is an internal bounded pipeline context, not a public reader or feed.
CREATE FUNCTION managed_knowledge_private.context_v1(input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $context$
DECLARE entities_json jsonb; items_json jsonb; result jsonb; ids uuid[]; limit_count integer; item_count integer;
BEGIN
  IF NOT (pg_has_role(session_user,'myboon_knowledge_executor','member') OR pg_has_role(session_user,'myboon_knowledge_context_executor','member'))
    OR pg_has_role(session_user,'myboon_knowledge_owner','member') OR pg_has_role(session_user,'service_role','member') OR pg_has_role(session_user,'authenticator','member')
    OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname = session_user AND (rolsuper OR rolbypassrls))
    OR session_user IN ('authenticator','anon','authenticated','service_role') THEN
    RAISE EXCEPTION 'dedicated managed context login required' USING ERRCODE = '42501';
  END IF;
  IF octet_length(input::text) > 131072 OR jsonb_typeof(input) <> 'object' THEN RAISE EXCEPTION 'bounded context input required' USING ERRCODE = '22023'; END IF;
  IF jsonb_typeof(input->'labels') <> 'array' OR jsonb_array_length(input->'labels') > 100
    OR jsonb_typeof(input->'sourceRefs') <> 'array' OR jsonb_array_length(input->'sourceRefs') > 32
    OR jsonb_typeof(input->'entityIds') <> 'array' OR jsonb_array_length(input->'entityIds') > 32
    OR jsonb_typeof(input->'itemIds') <> 'array' OR jsonb_array_length(input->'itemIds') > 32 THEN
    RAISE EXCEPTION 'bounded context identities required' USING ERRCODE = '22023';
  END IF;
  limit_count := greatest(1,least(coalesce((input->>'limit')::integer,24),32));
  -- Serializes context capture against accepted writes; snapshots never mix
  -- item state, provenance and revision watermarks from different commits.
  PERFORM pg_advisory_xact_lock(299,4);
  WITH subject_entities AS (
    SELECT DISTINCT membership.entity_id AS id FROM managed_knowledge_private.memberships membership
    JOIN managed_knowledge_private.item_sources item_source ON item_source.item_id = membership.item_id
    JOIN managed_knowledge_private.sources source ON source.work_id = item_source.work_id
    WHERE membership.removed_operation IS NULL AND source.source = input->>'source'
      AND source.source_refs ?| ARRAY(SELECT jsonb_array_elements_text(input->'sourceRefs'))
    UNION SELECT value::uuid FROM jsonb_array_elements_text(input->'entityIds') value
    UNION SELECT membership.entity_id FROM managed_knowledge_private.memberships membership
      WHERE membership.item_id::text IN (SELECT jsonb_array_elements_text(input->'itemIds')) AND membership.removed_operation IS NULL
  ), candidates AS (
    SELECT entity.id, entity.binding
      || CASE WHEN catalog.id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('slug',catalog.slug,'name',catalog.name,'type',catalog.type,'aliases',catalog.aliases,'summary',catalog.summary,'metadata',catalog.metadata,'status',catalog.status,'updated_at',catalog.updated_at) END
      || jsonb_build_object('revision',managed_knowledge_private.entity_revision_v1(entity.id)) AS binding
      FROM managed_knowledge_private.entities entity LEFT JOIN public.entities catalog ON catalog.id = entity.catalog_entity_id
      WHERE managed_knowledge_private.entity_revision_v1(entity.id) <> 'unavailable'
      AND (entity.id IN (SELECT id FROM subject_entities) OR EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(input->'labels') label WHERE lower(btrim(label)) = lower(btrim(coalesce(catalog.name,entity.binding->>'name')))
          OR lower(btrim(label)) = lower(btrim(coalesce(catalog.slug,entity.binding->>'slug')))
          OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(to_jsonb(catalog.aliases),entity.binding->'aliases')) alias WHERE lower(btrim(alias)) = lower(btrim(label)))
      ))
    UNION ALL
    SELECT entity.id,jsonb_build_object('id',entity.id,'slug',entity.slug,'name',entity.name,'type',entity.type,'aliases',entity.aliases,
      'summary',entity.summary,'status',entity.status,'show_in_carousel',false,'metadata',entity.metadata,
      'created_at',entity.created_at,'updated_at',entity.updated_at,'revision',managed_knowledge_private.entity_revision_v1(entity.id),
      'catalogEntityId',entity.id,'identityKey','catalog:' || entity.id::text)
      FROM public.entities entity WHERE entity.status = 'active' AND NOT EXISTS(SELECT 1 FROM managed_knowledge_private.entities own WHERE own.id = entity.id)
      AND (entity.id IN (SELECT id FROM subject_entities) OR EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(input->'labels') label WHERE lower(btrim(label)) = lower(btrim(entity.name))
          OR lower(btrim(label)) = lower(btrim(entity.slug))
          OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(entity.aliases) alias WHERE lower(btrim(alias)) = lower(btrim(label)))
      ))
  ) SELECT coalesce(jsonb_agg(binding ORDER BY id),'[]'::jsonb) INTO entities_json FROM (SELECT * FROM candidates ORDER BY id LIMIT 101) bounded;
  ids := ARRAY(SELECT (value->>'id')::uuid FROM jsonb_array_elements(entities_json) value);
  SELECT count(*) INTO item_count FROM managed_knowledge_private.items item
    WHERE item.id::text IN (SELECT jsonb_array_elements_text(input->'itemIds')) OR EXISTS(
      SELECT 1 FROM managed_knowledge_private.memberships membership WHERE membership.item_id = item.id AND membership.entity_id = ANY(ids) AND membership.removed_operation IS NULL);
  SELECT coalesce(jsonb_agg(snapshot ORDER BY observed_at DESC,id),'[]'::jsonb) INTO items_json FROM (
    SELECT item.id,item.observed_at,jsonb_build_object(
      'itemId',item.id,'note',item.note,'status',head.status,'revision','item:' || head.revision::text,'observedAt',item.observed_at,
      'entityIds',coalesce((SELECT jsonb_agg(entity_id ORDER BY entity_id) FROM managed_knowledge_private.memberships WHERE item_id = item.id AND removed_operation IS NULL),'[]'::jsonb),
      'packetRefs',coalesce((SELECT jsonb_agg(packet_id ORDER BY work_id) FROM (SELECT source.work_id,source.packet->>'packetId' AS packet_id FROM managed_knowledge_private.item_sources linkage JOIN managed_knowledge_private.sources source USING(work_id) WHERE linkage.item_id = item.id ORDER BY source.created_at DESC,source.work_id LIMIT 64) refs),'[]'::jsonb),
      'evidenceRefs',coalesce((SELECT jsonb_agg(jsonb_build_object('claimId',claim_id,'evidenceId',evidence_id,'sourceRef',source_ref) ORDER BY work_id,claim_id,evidence_id) FROM (SELECT work_id,claim_id,evidence_id,source_ref FROM managed_knowledge_private.evidence WHERE item_id = item.id ORDER BY work_id,claim_id,evidence_id LIMIT 128) refs),'[]'::jsonb),
      'successorItemIds',coalesce((SELECT jsonb_agg(to_item ORDER BY to_item) FROM managed_knowledge_private.developments WHERE from_item = item.id AND kind IN ('correct','supersede')),'[]'::jsonb)
    ) AS snapshot FROM managed_knowledge_private.items item JOIN managed_knowledge_private.item_heads head ON head.item_id = item.id
    WHERE item.id::text IN (SELECT jsonb_array_elements_text(input->'itemIds')) OR EXISTS(
      SELECT 1 FROM managed_knowledge_private.memberships membership WHERE membership.item_id = item.id AND membership.entity_id = ANY(ids) AND membership.removed_operation IS NULL)
    ORDER BY item.observed_at DESC,item.id LIMIT limit_count
  ) bounded;
  result := jsonb_build_object('entities',entities_json,'items',items_json,'watermark',(SELECT coalesce(max(sequence),0)::text FROM managed_knowledge_private.history),
    'truncated',jsonb_array_length(entities_json) > 32 OR item_count > limit_count OR EXISTS(
      SELECT 1 FROM jsonb_array_elements(items_json) selected WHERE
        (SELECT count(*) FROM managed_knowledge_private.item_sources WHERE item_id = (selected->>'itemId')::uuid) > 64
        OR (SELECT count(*) FROM managed_knowledge_private.evidence WHERE item_id = (selected->>'itemId')::uuid) > 128));
  RETURN result || jsonb_build_object('digest',managed_knowledge_private.digest_v1(result));
END
$context$;

CREATE FUNCTION managed_knowledge_private.writer_v1(action text, input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $writer$
DECLARE
  operation text := input->>'operationId'; work text := input->>'workId';
  lease managed_knowledge_private.leases; saved managed_knowledge_private.plans;
  source_row managed_knowledge_private.sources; context_row managed_knowledge_private.planning_contexts;
  existing jsonb; result jsonb; revision integer; ttl integer; effect jsonb; link jsonb; binding jsonb; evidence_ref jsonb;
  claim_json jsonb; evidence_json jsonb; item uuid; entity uuid; successor uuid; target record; expected text; actual text;
  snapshot jsonb; operation_kind text; now_value timestamptz := clock_timestamp(); created_ids jsonb;
  dispatch managed_knowledge_private.planning_dispatches;
BEGIN
  IF NOT pg_has_role(session_user,'myboon_knowledge_executor','member')
    OR pg_has_role(session_user,'myboon_knowledge_owner','member') OR pg_has_role(session_user,'service_role','member') OR pg_has_role(session_user,'authenticator','member')
    OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname = session_user AND (rolsuper OR rolbypassrls))
    OR session_user IN ('authenticator','anon','authenticated','service_role') THEN
    RAISE EXCEPTION 'dedicated managed writer login required' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(input) <> 'object' OR octet_length(input::text) > 17825792 THEN RAISE EXCEPTION 'bounded writer input required' USING ERRCODE = '22023'; END IF;
  IF operation IS NOT NULL AND operation !~ '^progression-v2:[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid operation identity' USING ERRCODE = '22023'; END IF;
  IF work IS NOT NULL AND (length(work) NOT BETWEEN 1 AND 1000 OR work <> btrim(work)) THEN RAISE EXCEPTION 'invalid work identity' USING ERRCODE = '22023'; END IF;
  IF operation IS NOT NULL AND work IS NOT NULL AND operation <> 'progression-v2:' || managed_knowledge_private.digest_v1(jsonb_build_object('schemaVersion','myboon.progression_operation_key.v2','workId',work)) THEN
    RAISE EXCEPTION 'work-owned operation identity mismatch' USING ERRCODE = 'MK001';
  END IF;
  IF action = 'status' THEN
    IF input->>'source' IS NOT NULL AND input->>'source' NOT IN ('news','polymarket') THEN RAISE EXCEPTION 'unsupported managed source' USING ERRCODE = '22023'; END IF;
    RETURN jsonb_build_object('schemaVersion','myboon.managed_knowledge_status.v1','capturedAt',clock_timestamp(),'source',input->>'source',
      'plans',(SELECT count(*) FROM managed_knowledge_private.plans p JOIN managed_knowledge_private.sources s ON s.work_id = p.plan->>'workId' WHERE input->>'source' IS NULL OR s.source = input->>'source'),
      'holds',(SELECT count(*) FROM managed_knowledge_private.holds h LEFT JOIN managed_knowledge_private.sources s ON s.work_id = h.receipt->>'workId' WHERE input->>'source' IS NULL OR s.source = input->>'source'),
      'leases',(SELECT count(*) FROM managed_knowledge_private.leases l WHERE l.expires_at > clock_timestamp() AND (input->>'source' IS NULL OR EXISTS(SELECT 1 FROM managed_knowledge_private.sources s WHERE s.source = input->>'source' AND l.operation_id = 'progression-v2:' || managed_knowledge_private.digest_v1(jsonb_build_object('schemaVersion','myboon.progression_operation_key.v2','workId',s.work_id))))),
      'receipts',(SELECT count(*) FROM managed_knowledge_private.receipts r JOIN managed_knowledge_private.sources s USING(work_id) WHERE input->>'source' IS NULL OR s.source = input->>'source'),
      'items',(SELECT count(*) FROM managed_knowledge_private.items i JOIN managed_knowledge_private.sources s USING(work_id) WHERE input->>'source' IS NULL OR s.source = input->>'source'),
      'contexts',(SELECT count(*) FROM managed_knowledge_private.planning_contexts c JOIN managed_knowledge_private.sources s USING(work_id) WHERE input->>'source' IS NULL OR s.source = input->>'source'),
      'unresolvedPlanningDispatches',(SELECT count(*) FROM managed_knowledge_private.planning_dispatches d JOIN managed_knowledge_private.sources s USING(work_id) WHERE d.state IN ('dispatched','held') AND (input->>'source' IS NULL OR s.source = input->>'source')));
  ELSIF action = 'receipt' THEN
    SELECT receipt INTO result FROM managed_knowledge_private.receipts WHERE operation_id = operation; RETURN result;
  ELSIF action = 'plan' THEN
    SELECT plan.snapshot INTO result FROM managed_knowledge_private.plans plan WHERE operation_id = operation AND attempt_digest = input->>'attemptDigest'
      AND NOT EXISTS(SELECT 1 FROM managed_knowledge_private.holds hold WHERE hold.operation_id = operation AND hold.plan_revision = plan.revision)
      ORDER BY plan.revision DESC LIMIT 1; RETURN result;
  ELSIF action = 'plan_history' THEN
    SELECT coalesce(jsonb_agg(p.snapshot ORDER BY p.revision),'[]'::jsonb) INTO result FROM managed_knowledge_private.plans p WHERE operation_id = operation; RETURN result;
  ELSIF action = 'hold_history' THEN
    SELECT coalesce(jsonb_agg(receipt ORDER BY sequence),'[]'::jsonb) INTO result FROM managed_knowledge_private.holds WHERE operation_id = operation; RETURN result;
  ELSIF action = 'planning_dispatch' THEN
    SELECT jsonb_build_object('operationId',operation_id,'attemptDigest',attempt_digest,'requestDigest',request_digest,'providerRoute',provider_route,'state',state,'dispatchedAt',dispatched_at)
      INTO result FROM managed_knowledge_private.planning_dispatches WHERE operation_id = operation
      AND (input->>'attemptDigest' IS NULL OR attempt_digest = input->>'attemptDigest') ORDER BY dispatched_at DESC LIMIT 1;
    RETURN result;
  ELSIF action = 'targets_current' THEN
    RETURN to_jsonb(managed_knowledge_private.targets_current_v1(input->'targetRevisions',input->>'watermark'));
  ELSIF action = 'source' THEN
    IF input->'packet'->>'schemaVersion' IS DISTINCT FROM 'myboon.research_packet.v1'
      OR input->'readiness'->>'schemaVersion' IS DISTINCT FROM 'myboon.research_readiness.v1'
      OR input->'packet'->>'workId' IS DISTINCT FROM work OR input->'packet'->>'sourceType' IS DISTINCT FROM input->>'source'
      OR input->'readiness'->>'workId' IS DISTINCT FROM work OR input->'readiness'->>'packetId' IS DISTINCT FROM input->'packet'->>'packetId'
      OR input->'readiness'->>'signalId' IS DISTINCT FROM input->'packet'->>'signalId'
      OR input->'readiness'->>'sourceType' IS DISTINCT FROM input->'packet'->>'sourceType'
      OR input->'readiness'->>'packetCompletion' IS DISTINCT FROM input->'packet'->>'completion'
      OR coalesce(input->'readiness'->>'outcome','') NOT IN ('ready_for_entity','resolved_without_new_item')
      OR (input->>'packetCanonical')::jsonb IS DISTINCT FROM input->'packet'
      OR (input->>'readinessCanonical')::jsonb IS DISTINCT FROM input->'readiness'
      OR encode(sha256(convert_to(input->>'packetCanonical','UTF8')),'hex') IS DISTINCT FROM input->>'packetDigest'
      OR encode(sha256(convert_to(input->>'readinessCanonical','UTF8')),'hex') IS DISTINCT FROM input->>'readinessDigest' THEN
      RAISE EXCEPTION 'immutable Research source proof mismatch' USING ERRCODE = 'MK001';
    END IF;
    INSERT INTO managed_knowledge_private.sources(work_id,packet_digest,packet,readiness,readiness_digest,source,source_refs,retrieved_evidence)
      VALUES(work,input->>'packetDigest',input->'packet',input->'readiness',input->>'readinessDigest',input->>'source',input->'sourceRefs',input->'evidence') ON CONFLICT DO NOTHING;
    SELECT * INTO source_row FROM managed_knowledge_private.sources WHERE work_id = work;
    IF source_row.packet_digest IS DISTINCT FROM input->>'packetDigest' OR source_row.readiness_digest IS DISTINCT FROM input->>'readinessDigest'
      OR source_row.source_refs IS DISTINCT FROM input->'sourceRefs' OR source_row.retrieved_evidence IS DISTINCT FROM input->'evidence' THEN
      RAISE EXCEPTION 'saved Research source cannot be rewritten' USING ERRCODE = 'MK001';
    END IF;
    RETURN 'true'::jsonb;
  ELSIF action = 'context_checkpoint' THEN
    IF input->>'contextDigest' !~ '^[0-9a-f]{64}$' OR (input->>'watermark') !~ '^[0-9]+$' OR octet_length(input::text) > 1048576 THEN RAISE EXCEPTION 'invalid context snapshot' USING ERRCODE = '22023'; END IF;
    INSERT INTO managed_knowledge_private.planning_contexts(work_id,context_digest,watermark,entities,item_revisions,snapshot)
      VALUES(work,input->>'contextDigest',(input->>'watermark')::bigint,input->'entities',input->'itemRevisions',input) ON CONFLICT DO NOTHING;
    SELECT checkpoint.snapshot INTO existing FROM managed_knowledge_private.planning_contexts checkpoint WHERE work_id = work AND context_digest = input->>'contextDigest';
    IF existing IS DISTINCT FROM input THEN RAISE EXCEPTION 'context snapshot cannot be rewritten' USING ERRCODE = 'MK001'; END IF;
    RETURN 'true'::jsonb;
  ELSIF action = 'acquire' THEN
    ttl := (input->>'leaseTtlMs')::integer;
    IF ttl NOT BETWEEN 30000 AND 300000 OR length(input->>'owner') NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'invalid lease request' USING ERRCODE = '22023'; END IF;
    INSERT INTO managed_knowledge_private.leases(operation_id,owner,epoch,expires_at)
      VALUES(operation,input->>'owner',1,clock_timestamp() + ttl * interval '1 millisecond')
      ON CONFLICT(operation_id) DO UPDATE SET owner = excluded.owner,epoch = leases.epoch + 1,expires_at = clock_timestamp() + ttl * interval '1 millisecond'
      WHERE leases.expires_at <= clock_timestamp() RETURNING * INTO lease;
    IF lease.operation_id IS NULL THEN RETURN NULL; END IF;
    RETURN jsonb_build_object('operationId',operation,'owner',lease.owner,'epoch',lease.epoch,'expiresAt',lease.expires_at);
  ELSIF action IN ('lease','renew','release') THEN
    SELECT * INTO lease FROM managed_knowledge_private.leases WHERE operation_id = operation FOR UPDATE;
    IF lease.operation_id IS NULL OR lease.owner IS DISTINCT FROM input->>'owner' OR (action <> 'lease' AND lease.epoch IS DISTINCT FROM (input->>'epoch')::bigint) THEN
      IF action = 'release' THEN RETURN 'false'::jsonb; END IF; RETURN NULL;
    END IF;
    IF action = 'release' THEN UPDATE managed_knowledge_private.leases SET expires_at = clock_timestamp() WHERE operation_id = operation; RETURN 'true'::jsonb; END IF;
    IF lease.expires_at <= clock_timestamp() THEN RETURN NULL; END IF;
    IF action = 'renew' THEN
      ttl := (input->>'leaseTtlMs')::integer;
      IF ttl NOT BETWEEN 30000 AND 300000 THEN RAISE EXCEPTION 'invalid lease renewal' USING ERRCODE = '22023'; END IF;
      UPDATE managed_knowledge_private.leases SET expires_at = clock_timestamp() + ttl * interval '1 millisecond' WHERE operation_id = operation RETURNING * INTO lease;
    END IF;
    RETURN jsonb_build_object('operationId',operation,'owner',lease.owner,'epoch',lease.epoch,'expiresAt',lease.expires_at);
  END IF;
  IF action = 'resolve_plan_dispatch' THEN
    IF input->>'resolution' IS DISTINCT FROM 'confirmed_no_execution' OR input->'proof'->>'source' IS DISTINCT FROM 'provider_execution_record'
      OR coalesce(input->'proof'->>'proofDigest','') !~ '^[0-9a-f]{64}$' OR length(btrim(coalesce(input->'proof'->>'provider',''))) NOT BETWEEN 1 AND 200
      OR length(btrim(coalesce(input->'proof'->>'proofRef',''))) NOT BETWEEN 1 AND 1000 OR length(btrim(coalesce(input->'proof'->>'confirmedBy',''))) NOT BETWEEN 1 AND 200 THEN
      RAISE EXCEPTION 'attributable operator nonexecution proof required' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO lease FROM managed_knowledge_private.leases WHERE operation_id = operation FOR UPDATE;
    IF lease.expires_at > clock_timestamp() THEN RAISE EXCEPTION 'cannot reconcile an active planning lease' USING ERRCODE = 'MK002'; END IF;
    SELECT * INTO dispatch FROM managed_knowledge_private.planning_dispatches WHERE operation_id = operation AND attempt_digest = input->>'attemptDigest' FOR UPDATE;
    IF dispatch.request_digest IS DISTINCT FROM input->>'requestDigest'
      OR dispatch.provider_route->'primary'->>'provider' IS NULL
      OR dispatch.provider_route->'primary'->>'provider' IS DISTINCT FROM input->'proof'->>'provider' THEN
      RAISE EXCEPTION 'operator proof is not bound to the dispatched request' USING ERRCODE = 'MK001';
    END IF;
    UPDATE managed_knowledge_private.planning_dispatches SET state = 'resolved_without_execution' WHERE operation_id = operation AND attempt_digest = input->>'attemptDigest' AND state IN ('dispatched','held');
    IF NOT FOUND THEN RAISE EXCEPTION 'unresolved dispatch not found' USING ERRCODE = 'MK001'; END IF;
    INSERT INTO managed_knowledge_private.planning_dispatch_events(operation_id,attempt_digest,state,proof) VALUES(operation,input->>'attemptDigest','resolved_without_execution',input->'proof' || jsonb_build_object('requestDigest',input->>'requestDigest','resolution',input->>'resolution'));
    RETURN 'true'::jsonb;
  END IF;
  IF action NOT IN ('save_plan','hold','commit','reserve_plan_dispatch') THEN RAISE EXCEPTION 'unknown managed writer action' USING ERRCODE = '22023'; END IF;
  SELECT * INTO lease FROM managed_knowledge_private.leases WHERE operation_id = operation FOR UPDATE;
  -- Receipt replay is deliberately before the lease/config checks.
  SELECT receipt INTO existing FROM managed_knowledge_private.receipts WHERE operation_id = operation;
  IF existing IS NOT NULL THEN
    IF action <> 'commit' OR existing->>'workId' IS DISTINCT FROM work OR existing->>'planDigest' IS DISTINCT FROM input->>'planDigest' OR existing->>'contentDigest' IS DISTINCT FROM input->>'contentDigest' THEN
      RAISE EXCEPTION 'terminal receipt is immutable' USING ERRCODE = 'MK001';
    END IF;
    RETURN jsonb_build_object('receipt',existing,'alreadyAccepted',true);
  END IF;
  IF lease.operation_id IS NULL OR lease.owner IS DISTINCT FROM input->>'owner' OR lease.epoch IS DISTINCT FROM (input->>'epoch')::bigint OR lease.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'stale managed writer lease' USING ERRCODE = 'MK002';
  END IF;
  IF input->>'attemptDigest' !~ '^[0-9a-f]{64}$' OR input->>'planDigest' !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid operation digests' USING ERRCODE = '22023'; END IF;
  IF action = 'reserve_plan_dispatch' THEN
    SELECT * INTO dispatch FROM managed_knowledge_private.planning_dispatches WHERE operation_id = operation AND state IN ('dispatched','held') ORDER BY dispatched_at LIMIT 1;
    IF dispatch.operation_id IS NOT NULL THEN
      RETURN jsonb_build_object('reserved',false,'dispatch',jsonb_build_object('operationId',operation,'attemptDigest',dispatch.attempt_digest,'state',dispatch.state,'dispatchedAt',dispatch.dispatched_at));
    END IF;
    IF input->>'requestDigest' !~ '^[0-9a-f]{64}$' OR jsonb_typeof(input->'providerRoute') <> 'object' OR octet_length((input->'providerRoute')::text) > 16384 THEN RAISE EXCEPTION 'bounded dispatch request binding required' USING ERRCODE = '22023'; END IF;
    INSERT INTO managed_knowledge_private.planning_dispatches(operation_id,work_id,attempt_digest,owner_epoch,request_digest,provider_route,state)
      VALUES(operation,work,input->>'attemptDigest',lease.epoch,input->>'requestDigest',input->'providerRoute','dispatched')
      ON CONFLICT(operation_id,attempt_digest) DO UPDATE SET state = 'dispatched',owner_epoch = excluded.owner_epoch,request_digest = excluded.request_digest,provider_route = excluded.provider_route,dispatched_at = clock_timestamp()
      WHERE planning_dispatches.state = 'resolved_without_execution' RETURNING * INTO dispatch;
    IF dispatch.operation_id IS NULL THEN
      SELECT * INTO dispatch FROM managed_knowledge_private.planning_dispatches WHERE operation_id = operation AND attempt_digest = input->>'attemptDigest';
      RETURN jsonb_build_object('reserved',false,'dispatch',jsonb_build_object('operationId',operation,'attemptDigest',dispatch.attempt_digest,'state',dispatch.state,'dispatchedAt',dispatch.dispatched_at));
    END IF;
    INSERT INTO managed_knowledge_private.planning_dispatch_events(operation_id,attempt_digest,state) VALUES(operation,input->>'attemptDigest','dispatched');
    RETURN jsonb_build_object('reserved',true,'dispatch',jsonb_build_object('operationId',operation,'attemptDigest',dispatch.attempt_digest,'state',dispatch.state,'dispatchedAt',dispatch.dispatched_at));
  END IF;
  IF action = 'save_plan' THEN
    IF input->'plan'->>'operationId' IS DISTINCT FROM operation OR input->'plan'->>'workId' IS DISTINCT FROM work
      OR (input->>'planCanonical')::jsonb IS DISTINCT FROM input->'plan'
      OR encode(sha256(convert_to(input->>'planCanonical','UTF8')),'hex') IS DISTINCT FROM input->>'planDigest'
      OR (input->>'effectsCanonical')::jsonb IS DISTINCT FROM input->'effects' THEN
      RAISE EXCEPTION 'validated plan proof mismatch' USING ERRCODE = 'MK001';
    END IF;
    SELECT * INTO saved FROM managed_knowledge_private.plans plan WHERE operation_id = operation AND attempt_digest = input->>'attemptDigest'
      AND NOT EXISTS(SELECT 1 FROM managed_knowledge_private.holds hold WHERE hold.operation_id = operation AND hold.plan_revision = plan.revision) ORDER BY plan.revision DESC LIMIT 1;
    IF saved.operation_id IS NOT NULL THEN
      IF saved.plan_digest IS DISTINCT FROM input->>'planDigest' THEN RAISE EXCEPTION 'saved attempt is immutable' USING ERRCODE = 'MK001'; END IF;
      RETURN saved.snapshot;
    END IF;
    SELECT coalesce(max(plans.revision),0)+1 INTO revision FROM managed_knowledge_private.plans WHERE operation_id = operation;
    snapshot := jsonb_build_object('revision',revision,'attemptDigest',input->>'attemptDigest','plan',input->'plan','planDigest',input->>'planDigest','savedAt',clock_timestamp(),'owner',lease.owner,'ownerEpoch',lease.epoch);
    INSERT INTO managed_knowledge_private.plans(operation_id,revision,attempt_digest,plan_digest,plan,effects,snapshot) VALUES(operation,revision,input->>'attemptDigest',input->>'planDigest',input->'plan',input->'effects',snapshot);
    UPDATE managed_knowledge_private.planning_dispatches
      SET state = CASE WHEN input->'plan'->'outcome'->>'kind' = 'hold' AND input->'plan'->'outcome'->>'missingDependency' = 'planning_dispatch_reconciliation' THEN 'held' ELSE 'settled' END
      WHERE operation_id = operation AND attempt_digest = input->>'attemptDigest' AND state = 'dispatched';
    IF FOUND THEN INSERT INTO managed_knowledge_private.planning_dispatch_events(operation_id,attempt_digest,state)
      SELECT operation_id,attempt_digest,state FROM managed_knowledge_private.planning_dispatches WHERE operation_id = operation AND attempt_digest = input->>'attemptDigest'; END IF;
    RETURN snapshot;
  END IF;
  IF input->>'contentDigest' !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid content digest' USING ERRCODE = '22023'; END IF;
  IF (input->>'planRevision') IS NOT NULL THEN
    SELECT * INTO saved FROM managed_knowledge_private.plans WHERE operation_id = operation AND plans.revision = (input->>'planRevision')::integer;
    IF saved.operation_id IS NULL OR saved.attempt_digest IS DISTINCT FROM input->>'attemptDigest' OR saved.plan_digest IS DISTINCT FROM input->>'planDigest' OR saved.plan->>'workId' IS DISTINCT FROM work THEN
      RAISE EXCEPTION 'operation does not match checkpointed plan' USING ERRCODE = 'MK001';
    END IF;
  ELSIF action = 'commit' THEN RAISE EXCEPTION 'commit requires a saved plan' USING ERRCODE = 'MK001'; END IF;
  result := jsonb_build_object('schemaVersion','myboon.knowledge_operation_receipt.v2','operationId',operation,'workId',work,
    'attemptDigest',input->>'attemptDigest','planRevision',(input->>'planRevision')::integer,'planDigest',input->>'planDigest',
    'owner',lease.owner,'ownerEpoch',lease.epoch,'contentDigest',input->>'contentDigest','committedAt',clock_timestamp());
  IF action = 'hold' THEN
    IF length(btrim(input->>'reason')) NOT BETWEEN 1 AND 1000 OR length(btrim(input->>'missingDependency')) NOT BETWEEN 1 AND 1000
      OR (input->>'retainedGroups')::integer < 0 OR ((input->>'retainedGroups')::integer > 0 AND input->'retainedPayload' = 'null'::jsonb)
      OR (input->>'contentCanonical')::jsonb IS DISTINCT FROM jsonb_build_object('schemaVersion','myboon.knowledge_operation_hold.v1','reason',input->>'reason','missingDependency',input->>'missingDependency','retainedGroups',(input->>'retainedGroups')::integer,'retainedPayload',input->'retainedPayload')
      OR input->>'contentDigest' IS DISTINCT FROM encode(sha256(convert_to(input->>'contentCanonical','UTF8')),'hex') THEN
      RAISE EXCEPTION 'held payload proof mismatch' USING ERRCODE = 'MK001';
    END IF;
    result := result || jsonb_build_object('status','held','reason',input->>'reason','missingDependency',input->>'missingDependency','retainedGroups',(input->>'retainedGroups')::integer,'retainedPayload',input->'retainedPayload');
    INSERT INTO managed_knowledge_private.holds(operation_id,owner_epoch,attempt_digest,plan_revision,plan_digest,content_digest,receipt)
      VALUES(operation,lease.epoch,input->>'attemptDigest',(input->>'planRevision')::integer,input->>'planDigest',input->>'contentDigest',result) ON CONFLICT DO NOTHING;
    SELECT receipt INTO result FROM managed_knowledge_private.holds WHERE operation_id = operation AND owner_epoch = lease.epoch AND attempt_digest = input->>'attemptDigest'
      AND plan_revision IS NOT DISTINCT FROM (input->>'planRevision')::integer AND plan_digest = input->>'planDigest' AND content_digest = input->>'contentDigest';
    UPDATE managed_knowledge_private.planning_dispatches SET state = 'held' WHERE operation_id = operation AND state = 'dispatched';
    IF FOUND THEN INSERT INTO managed_knowledge_private.planning_dispatch_events(operation_id,attempt_digest,state) SELECT operation_id,attempt_digest,'held' FROM managed_knowledge_private.planning_dispatches WHERE operation_id = operation AND state = 'held'; END IF;
    RETURN jsonb_build_object('receipt',result,'alreadyAccepted',false);
  END IF;

  PERFORM pg_advisory_xact_lock(299,4);
  IF EXISTS(SELECT 1 FROM managed_knowledge_private.holds WHERE operation_id = operation AND plan_revision = saved.revision) THEN RAISE EXCEPTION 'held plan cannot commit' USING ERRCODE = 'MK001'; END IF;
  SELECT * INTO source_row FROM managed_knowledge_private.sources WHERE work_id = work;
  SELECT * INTO context_row FROM managed_knowledge_private.planning_contexts WHERE work_id = work AND context_digest = saved.plan->>'contextDigest';
  IF source_row.work_id IS NULL OR context_row.work_id IS NULL OR source_row.packet_digest IS DISTINCT FROM saved.plan->>'packetDigest'
    OR source_row.readiness_digest IS DISTINCT FROM saved.plan->'decisionVersions'->>'readiness'
    OR context_row.watermark::text IS DISTINCT FROM saved.plan->>'contextWatermark'
    OR input->'targetRevisions' IS DISTINCT FROM saved.plan->'targetRevisions' THEN
    RAISE EXCEPTION 'saved plan dependencies do not match' USING ERRCODE = 'MK001';
  END IF;
  IF NOT managed_knowledge_private.targets_current_v1(input->'targetRevisions',saved.plan->>'contextWatermark') THEN
    RAISE EXCEPTION 'stale managed target/context' USING ERRCODE = 'MK003', DETAIL = 'context';
  END IF;
  IF jsonb_typeof(input->'effects') <> 'array' OR jsonb_array_length(input->'effects') > 8 OR octet_length(input::text) > 1048576
    OR input->'effects' IS DISTINCT FROM saved.effects OR (input->>'effectsCanonical')::jsonb IS DISTINCT FROM input->'effects'
    OR encode(sha256(convert_to(input->>'effectsCanonical','UTF8')),'hex') IS DISTINCT FROM input->>'contentDigest' THEN RAISE EXCEPTION 'bounded effects/digest required' USING ERRCODE = 'MK001'; END IF;
  SELECT coalesce(jsonb_agg(value->>'itemId' ORDER BY value->>'itemId'),'[]'::jsonb) INTO created_ids FROM jsonb_array_elements(input->'effects') value WHERE value->>'kind' = 'managed_item';
  IF created_ids IS DISTINCT FROM (SELECT coalesce(jsonb_agg(value ORDER BY value),'[]'::jsonb) FROM jsonb_array_elements_text(input->'expectedAbsentItemIds') value)
    OR (SELECT count(*) FROM jsonb_array_elements(created_ids)) <> (SELECT count(DISTINCT value) FROM jsonb_array_elements_text(created_ids) value) THEN
    RAISE EXCEPTION 'expected-absent IDs do not match creations' USING ERRCODE = 'MK001';
  END IF;
  IF EXISTS(SELECT 1 FROM managed_knowledge_private.items WHERE id::text IN (SELECT jsonb_array_elements_text(created_ids))) THEN RAISE EXCEPTION 'new managed item already exists' USING ERRCODE = 'MK003',DETAIL = 'expected_absent'; END IF;
  -- Lock catalogue targets in deterministic order so alias/status corrections
  -- cannot race a committed membership. Private commits are already serialized.
  PERFORM entity.id FROM public.entities entity WHERE entity.id::text IN (SELECT jsonb_object_keys(input->'targetRevisions')) ORDER BY entity.id FOR SHARE;
  IF NOT managed_knowledge_private.targets_current_v1(input->'targetRevisions',saved.plan->>'contextWatermark') THEN RAISE EXCEPTION 'catalog target changed' USING ERRCODE = 'MK003',DETAIL = 'entity_catalog'; END IF;

  -- First create every immutable draft, then resolve same-plan links.
  FOR effect IN SELECT value FROM jsonb_array_elements(input->'effects') WHERE value->>'kind' = 'managed_item' LOOP
    item := (effect->>'itemId')::uuid;
    IF jsonb_typeof(effect->'payload'->'entityLinks') <> 'array' OR jsonb_array_length(effect->'payload'->'entityLinks') NOT BETWEEN 1 AND 8
      OR jsonb_typeof(effect->'payload'->'evidenceRefs') <> 'array' OR jsonb_array_length(effect->'payload'->'evidenceRefs') NOT BETWEEN 1 AND 32
      OR jsonb_typeof(effect->'payload'->'continuityLinks') <> 'array' OR jsonb_array_length(effect->'payload'->'continuityLinks') > 4 THEN RAISE EXCEPTION 'invalid draft links' USING ERRCODE = 'MK001'; END IF;
    INSERT INTO managed_knowledge_private.items(id,note,payload,operation_id,work_id,observed_at)
      VALUES(item,effect->'payload'->>'note',effect->'payload',operation,work,(source_row.packet->>'observedAt')::timestamptz);
    INSERT INTO managed_knowledge_private.item_heads(item_id) VALUES(item);
    FOR link IN SELECT value FROM jsonb_array_elements(effect->'payload'->'entityLinks') LOOP
      entity := (link->>'entityId')::uuid;
      SELECT value INTO binding FROM jsonb_array_elements(context_row.entities) value WHERE value->>'id' = entity::text;
      IF binding IS NULL OR NOT (input->'targetRevisions' ? entity::text) OR binding->>'revision' IS DISTINCT FROM input->'targetRevisions'->>entity::text THEN RAISE EXCEPTION 'entity not grounded in saved context' USING ERRCODE = 'MK001'; END IF;
      IF binding->>'catalogEntityId' IS NULL AND NOT EXISTS(SELECT 1 FROM managed_knowledge_private.entities WHERE id = entity) THEN
        IF entity IS DISTINCT FROM substr(encode(sha256(convert_to('myboon.entity_v4:' || (binding->>'identityKey'),'UTF8')),'hex'),1,32)::uuid
          OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(source_row.packet->'entityHints') hint WHERE lower(btrim(hint->>'name')) = lower(btrim(binding->>'name'))
            AND lower(btrim(coalesce(hint->>'type','unclassified'))) = lower(btrim(binding->>'type'))
            AND hint->>'role' IS NOT NULL AND hint->>'role' !~* '(publisher|source|venue|mention|context)'
            AND EXISTS(SELECT 1 FROM jsonb_array_elements(source_row.packet->'claims') claim WHERE lower(claim->>'claim') LIKE '%' || lower(binding->>'name') || '%' AND jsonb_array_length(claim->'evidenceRefs') > 0)) THEN
          RAISE EXCEPTION 'new Entity identity lacks packet grounding' USING ERRCODE = 'MK001';
        END IF;
      ELSIF binding->>'catalogEntityId' IS NOT NULL AND binding->>'catalogEntityId' IS DISTINCT FROM entity::text THEN RAISE EXCEPTION 'catalog identity mismatch' USING ERRCODE = 'MK001'; END IF;
      INSERT INTO managed_knowledge_private.entities(id,identity_key,catalog_entity_id,binding,created_operation)
        VALUES(entity,binding->>'identityKey',(binding->>'catalogEntityId')::uuid,binding,operation) ON CONFLICT(id) DO NOTHING;
      INSERT INTO managed_knowledge_private.memberships(item_id,entity_id,role,added_operation) VALUES(item,entity,link->>'role',operation);
    END LOOP;
  END LOOP;
  FOR effect IN SELECT value FROM jsonb_array_elements(input->'effects') LOOP
    item := (effect->>'itemId')::uuid;
    IF effect->>'kind' = 'existing_item_operation' THEN
      operation_kind := effect->'payload'->>'kind';
      IF NOT (input->'targetRevisions' ? item::text) OR NOT (context_row.item_revisions ? item::text) THEN RAISE EXCEPTION 'existing item not in grounded context' USING ERRCODE = 'MK001'; END IF;
      IF operation_kind NOT IN ('annotate','correct','supersede','retract','attach_evidence','remove_membership') THEN RAISE EXCEPTION 'unsupported existing item operation' USING ERRCODE = 'MK001'; END IF;
      IF operation_kind = 'attach_evidence' AND (jsonb_typeof(effect->'payload'->'evidenceRefs') <> 'array' OR jsonb_array_length(effect->'payload'->'evidenceRefs') NOT BETWEEN 1 AND 32) THEN RAISE EXCEPTION 'attachment requires saved evidence' USING ERRCODE = 'MK001'; END IF;
      IF operation_kind IN ('correct','supersede') THEN
        successor := (effect->'payload'->>'successorItemId')::uuid;
        IF successor IS NULL OR NOT (created_ids ? successor::text) OR item = successor THEN RAISE EXCEPTION 'successor must be a new same-plan draft' USING ERRCODE = 'MK001'; END IF;
        INSERT INTO managed_knowledge_private.developments(from_item,to_item,kind,operation_id) VALUES(item,successor,operation_kind,operation);
        UPDATE managed_knowledge_private.item_heads SET status = CASE operation_kind WHEN 'correct' THEN 'corrected' ELSE 'superseded' END WHERE item_id = item AND status = 'active';
        IF NOT FOUND THEN RAISE EXCEPTION 'only active items may be superseded/corrected' USING ERRCODE = 'MK003',DETAIL = item::text; END IF;
      ELSIF operation_kind = 'retract' THEN
        IF length(btrim(effect->'payload'->>'reason')) NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'retraction reason required' USING ERRCODE = 'MK001'; END IF;
        UPDATE managed_knowledge_private.item_heads SET status = 'retracted' WHERE item_id = item AND status = 'active';
        IF NOT FOUND THEN RAISE EXCEPTION 'only active items may be retracted' USING ERRCODE = 'MK003',DETAIL = item::text; END IF;
      ELSIF operation_kind = 'remove_membership' THEN
        entity := (effect->'payload'->>'entityId')::uuid;
        IF NOT (input->'targetRevisions' ? entity::text) THEN RAISE EXCEPTION 'membership revision required' USING ERRCODE = 'MK001'; END IF;
        UPDATE managed_knowledge_private.memberships SET removed_operation = operation WHERE item_id = item AND entity_id = entity AND removed_operation IS NULL;
        IF NOT FOUND THEN RAISE EXCEPTION 'membership is unavailable' USING ERRCODE = 'MK003',DETAIL = item::text; END IF;
      END IF;
      UPDATE managed_knowledge_private.item_heads SET revision = item_heads.revision + 1 WHERE item_id = item;
    ELSIF effect->>'kind' = 'managed_item' THEN
      FOR link IN SELECT value FROM jsonb_array_elements(effect->'payload'->'continuityLinks') LOOP
        successor := (link->>'itemId')::uuid;
        IF NOT (created_ids ? successor::text) THEN RAISE EXCEPTION 'unresolved continuity target' USING ERRCODE = 'MK001'; END IF;
        INSERT INTO managed_knowledge_private.developments(from_item,to_item,kind,operation_id) VALUES(item,successor,link->>'kind',operation);
      END LOOP;
    ELSE RAISE EXCEPTION 'unsupported managed effect kind' USING ERRCODE = 'MK001'; END IF;
    INSERT INTO managed_knowledge_private.item_sources(item_id,work_id,operation_id) VALUES(item,work,operation) ON CONFLICT DO NOTHING;
    FOR evidence_ref IN SELECT value FROM jsonb_array_elements(coalesce(effect->'payload'->'evidenceRefs','[]'::jsonb)) LOOP
      SELECT value INTO claim_json FROM jsonb_array_elements(source_row.packet->'claims') value WHERE value->>'claimId' = evidence_ref->>'claimId';
      SELECT value INTO evidence_json FROM jsonb_array_elements(source_row.packet->'evidence') value WHERE value->>'evidenceId' = evidence_ref->>'evidenceId';
      IF claim_json IS NULL OR evidence_json IS NULL OR NOT (claim_json->'evidenceRefs' ? (evidence_ref->>'evidenceId')) OR evidence_json->>'url' IS DISTINCT FROM evidence_ref->>'sourceRef' THEN
        RAISE EXCEPTION 'evidence tuple is not a saved Research edge' USING ERRCODE = 'MK001';
      END IF;
      INSERT INTO managed_knowledge_private.evidence(item_id,work_id,claim_id,evidence_id,source_ref,claim,evidence,operation_id)
        VALUES(item,work,evidence_ref->>'claimId',evidence_ref->>'evidenceId',evidence_ref->>'sourceRef',claim_json,evidence_json,operation) ON CONFLICT DO NOTHING;
    END LOOP;
    INSERT INTO managed_knowledge_private.history(operation_id,work_id,item_id,event_kind,payload) VALUES(operation,work,item,coalesce(operation_kind,'create'),effect);
    operation_kind := NULL;
  END LOOP;
  IF jsonb_array_length(input->'effects') = 0 AND saved.plan->'outcome'->>'kind' <> 'retain_observation' THEN RAISE EXCEPTION 'empty apply is not accepted' USING ERRCODE = 'MK001'; END IF;
  INSERT INTO managed_knowledge_private.history(operation_id,work_id,event_kind,payload) VALUES(operation,work,'accepted',jsonb_build_object('planDigest',input->>'planDigest','packetDigest',source_row.packet_digest,'readiness',source_row.readiness));
  result := result || jsonb_build_object('status','accepted','reason',NULL,'missingDependency',NULL,'retainedGroups',0,'retainedPayload',NULL);
  INSERT INTO managed_knowledge_private.receipts(operation_id,work_id,plan_revision,plan_digest,content_digest,receipt)
    VALUES(operation,work,saved.revision,input->>'planDigest',input->>'contentDigest',result);
  RETURN jsonb_build_object('receipt',result,'alreadyAccepted',false);
END
$writer$;

-- Explicitly revoke Supabase's default grants on every private object.
REVOKE ALL ON ALL TABLES IN SCHEMA managed_knowledge_private FROM PUBLIC, anon, authenticated, service_role, myboon_knowledge_executor, myboon_knowledge_context_executor;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA managed_knowledge_private FROM PUBLIC, anon, authenticated, service_role, myboon_knowledge_executor, myboon_knowledge_context_executor;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA managed_knowledge_private FROM PUBLIC, anon, authenticated, service_role, myboon_knowledge_executor, myboon_knowledge_context_executor;
GRANT EXECUTE ON FUNCTION managed_knowledge_private.writer_v1(text,jsonb) TO myboon_knowledge_executor;
GRANT EXECUTE ON FUNCTION managed_knowledge_private.context_v1(jsonb) TO myboon_knowledge_executor,myboon_knowledge_context_executor;
GRANT CREATE ON SCHEMA managed_knowledge_private TO myboon_knowledge_owner;
DO $function_ownership$
DECLARE
  already_can_set boolean := pg_catalog.pg_has_role(current_user,'myboon_knowledge_owner','SET');
BEGIN
  -- PostgreSQL 16+ role creators have ADMIN OPTION without SET by default.
  -- Give only the migration executor temporary SET for ownership transfer.
  IF NOT already_can_set THEN
    EXECUTE format('GRANT myboon_knowledge_owner TO %I WITH INHERIT FALSE, SET TRUE',current_user);
  END IF;
  ALTER FUNCTION managed_knowledge_private.canonical_json_v1(jsonb,integer) OWNER TO myboon_knowledge_owner;
  ALTER FUNCTION managed_knowledge_private.digest_v1(jsonb) OWNER TO myboon_knowledge_owner;
  ALTER FUNCTION managed_knowledge_private.entity_revision_v1(uuid) OWNER TO myboon_knowledge_owner;
  ALTER FUNCTION managed_knowledge_private.targets_current_v1(jsonb,text) OWNER TO myboon_knowledge_owner;
  ALTER FUNCTION managed_knowledge_private.context_v1(jsonb) OWNER TO myboon_knowledge_owner;
  ALTER FUNCTION managed_knowledge_private.writer_v1(text,jsonb) OWNER TO myboon_knowledge_owner;
  IF NOT already_can_set THEN
    EXECUTE format('REVOKE SET OPTION FOR myboon_knowledge_owner FROM %I',current_user);
  END IF;
END
$function_ownership$;
REVOKE CREATE ON SCHEMA managed_knowledge_private FROM myboon_knowledge_owner;
