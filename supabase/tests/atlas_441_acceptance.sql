-- #441 acceptance tests. Run on an EMPTY local/branch DB after the atlas migrations, never on prod.
-- Targets the schema after 20261031180000_atlas_entity_rename (#541).
-- Each block raises on failure; everything runs in one transaction and is rolled back.
\set ON_ERROR_STOP 1
begin;

insert into atlas.entities (slug, name, type) values ('t-main','T Main','topic'), ('t-other','T Other','topic');

-- 1. Unique keys reject duplicates.
do $$ begin
  insert into atlas.signals (signal_id, schema_version, source, source_id, type) values ('s1', 1, 'news', 'abc', 'news');
  begin
    insert into atlas.signals (signal_id, schema_version, source, source_id, type) values ('s2', 1, 'news', 'abc', 'news');
    raise exception 'FAIL: duplicate (source, source_id) accepted';
  exception when unique_violation then raise notice 'PASS 1a signals UNIQUE(source, source_id) rejects duplicate'; end;
  insert into atlas.decisions (schema_version, signal_id, analyst_version, action) values (1, 's1', 'a1', 'keep');
  begin
    insert into atlas.decisions (schema_version, signal_id, analyst_version, action) values (1, 's1', 'a1', 'skip');
    raise exception 'FAIL: duplicate (signal_id, analyst_version) accepted';
  exception when unique_violation then raise notice 'PASS 1b decisions UNIQUE(signal_id, analyst_version) rejects duplicate'; end;
  insert into atlas.entity_items (item_key, title, main_entity_id) select 'i1', 'Item 1', id from atlas.entities where slug = 't-main';
  insert into atlas.item_signals (item_id, signal_id) select id, 's1' from atlas.entity_items where item_key = 'i1';
  begin
    insert into atlas.item_signals (item_id, signal_id) select id, 's1' from atlas.entity_items where item_key = 'i1';
    raise exception 'FAIL: duplicate item_signals accepted';
  exception when unique_violation then raise notice 'PASS 1c item_signals PK(item_id, signal_id) rejects duplicate'; end;
  insert into atlas.stories (slug, title) values ('st1', 'Story 1');
  insert into atlas.story_items (story_id, item_id) select s.id, i.id from atlas.stories s, atlas.entity_items i where s.slug = 'st1' and i.item_key = 'i1';
  begin
    insert into atlas.story_items (story_id, item_id) select s.id, i.id from atlas.stories s, atlas.entity_items i where s.slug = 'st1' and i.item_key = 'i1';
    raise exception 'FAIL: duplicate story_items accepted';
  exception when unique_violation then raise notice 'PASS 1d story_items PK(story_id, item_id) rejects duplicate'; end;
  begin
    insert into atlas.entities (slug, name, type) values ('t-main', 'Dup', 'topic');
    raise exception 'FAIL: duplicate shelf slug accepted';
  exception when unique_violation then raise notice 'PASS 1e entities UNIQUE(slug) rejects duplicate'; end;
end $$;

-- 2. One main shelf: a second main fails, an item without one fails, self-merge fails.
do $$ begin
  begin
    insert into atlas.entity_item_links (item_id, entity_id, role) select i.id, s.id, 'main' from atlas.entity_items i, atlas.entities s where i.item_key = 'i1' and s.slug = 't-other';
    raise exception 'FAIL: second main shelf accepted';
  exception when check_violation then raise notice 'PASS 2a second main shelf rejected (entity_item_links role is also_affects only; main is items.main_entity_id)'; end;
  insert into atlas.entity_item_links (item_id, entity_id) select i.id, s.id from atlas.entity_items i, atlas.entities s where i.item_key = 'i1' and s.slug = 't-other';
  raise notice 'PASS 2b also_affects link accepted';
  begin
    insert into atlas.entity_items (item_key, title) values ('i2', 'No shelf');
    raise exception 'FAIL: item without main shelf accepted';
  exception when not_null_violation then raise notice 'PASS 2c item without main shelf rejected'; end;
  begin
    update atlas.entity_items set status = 'merged', merged_into_id = id where item_key = 'i1';
    raise exception 'FAIL: self-merge accepted';
  exception when check_violation then raise notice 'PASS 2d merged_into_id = id rejected'; end;
end $$;

-- 3. History is append-only and stores changed fields only.
do $$ declare v jsonb; begin
  update atlas.entity_items set title = 'Item 1 renamed' where item_key = 'i1';
  select changed into v from atlas.history where table_name = 'entity_items' and op = 'UPDATE' order by id desc limit 1;
  if v <> '{"title": "Item 1 renamed"}'::jsonb then raise exception 'FAIL: history changed = %', v; end if;
  raise notice 'PASS 3a history UPDATE row = %', v;
  begin update atlas.history set reason = 'x'; raise exception 'FAIL: history update allowed';
  exception when insufficient_privilege then raise notice 'PASS 3b history UPDATE blocked'; end;
  begin delete from atlas.history; raise exception 'FAIL: history delete allowed';
  exception when insufficient_privilege then raise notice 'PASS 3c history DELETE blocked'; end;
end $$;

-- 4. Read-only role cannot write any atlas table (and can read).
do $$ declare t record; n int := 0; begin
  set local role atlas_analyst;
  perform count(*) from atlas.entity_items;
  for t in select c.relname from pg_class c where c.relnamespace = 'atlas'::regnamespace and c.relkind in ('r','p') loop
    begin
      execute format('insert into atlas.%I default values', t.relname);
      raise exception 'FAIL: analyst inserted into %', t.relname;
    exception when insufficient_privilege then n := n + 1; end;
  end loop;
  reset role;
  raise notice 'PASS 4 atlas_analyst insert denied on % of % tables; SELECT works', n, n;
end $$;

-- 4b. Default privileges: a future atlas table is readable by the analyst.
do $$ begin
  create table atlas.zz_future (id int);
  if not has_table_privilege('atlas_analyst', 'atlas.zz_future', 'SELECT') then raise exception 'FAIL: no default SELECT'; end if;
  if has_table_privilege('atlas_analyst', 'atlas.zz_future', 'INSERT') then raise exception 'FAIL: default INSERT'; end if;
  if has_schema_privilege('anon', 'atlas', 'USAGE') or has_table_privilege('authenticated', 'atlas.entity_items', 'SELECT') then raise exception 'FAIL: API roles have access'; end if;
  drop table atlas.zz_future;
  raise notice 'PASS 4b future atlas tables get SELECT only for atlas_analyst; anon/authenticated have no access';
end $$;

-- 5. atlas.uuidv7() ids come out in time order.
do $$ declare a uuid[] := '{}'; i int; prev bigint := 0; ts bigint; u uuid; begin
  for i in 1..20 loop a := a || atlas.uuidv7(); perform pg_sleep(0.002); end loop;
  if a <> (select array_agg(x order by x) from unnest(a) x) then raise exception 'FAIL: ids across ms not sorted'; end if;
  for i in 1..10000 loop
    u := atlas.uuidv7();
    ts := ('x' || substr(replace(u::text, '-', ''), 1, 12))::bit(48)::bigint;
    if ts < prev then raise exception 'FAIL: timestamp went backwards'; end if;
    prev := ts;
    if substr(u::text, 15, 1) <> '7' then raise exception 'FAIL: version nibble %', u; end if;
  end loop;
  raise notice 'PASS 5 uuidv7: 20 ids 2ms apart sort in creation order; 10000 tight-loop ids have non-decreasing ms prefix and version 7';
end $$;

-- 6. Queue: SKIP LOCKED claim, lease token, dead-letter after max_attempts.
do $$ declare r record; res text; i int; begin
  insert into atlas.signal_queue (signal_id, max_attempts) values ('s1', 2);
  select * into r from atlas.queue_claim('signal_queue', 10, '5 minutes');
  if r.lease_token is null then raise exception 'FAIL: no lease'; end if;
  if (select count(*) from atlas.queue_claim('signal_queue', 10, '5 minutes')) <> 0 then raise exception 'FAIL: leased row claimed twice'; end if;
  res := atlas.queue_fail('signal_queue', r.id, r.lease_token, 'boom', '0 seconds');
  if res <> 'retry' then raise exception 'FAIL: first fail = %', res; end if;
  select * into r from atlas.queue_claim('signal_queue', 10, '5 minutes');
  if atlas.queue_fail('signal_queue', r.id, gen_random_uuid(), 'x') <> 'lost_lease' then raise exception 'FAIL: wrong token accepted'; end if;
  res := atlas.queue_fail('signal_queue', r.id, r.lease_token, 'boom2', '0 seconds');
  if res <> 'dead_letter' or (select count(*) from atlas.dead_letter where ref_id = 's1') <> 1 or exists (select 1 from atlas.signal_queue) then
    raise exception 'FAIL: dead-letter move (%)', res; end if;
  raise notice 'PASS 6 queue claim/lease/retry/dead-letter after max_attempts';
end $$;

-- 7. Tool log partitions exist for today + 3 days.
do $$ declare n int; begin
  select count(*) into n from pg_inherits where inhparent = 'atlas.tool_log'::regclass;
  if n < 4 then raise exception 'FAIL: % tool_log partitions', n; end if;
  insert into atlas.tool_log (tool) values ('test');
  raise notice 'PASS 7a tool_log has % daily partitions, insert routed', n;
  create table atlas.tool_log_p20200101 partition of atlas.tool_log for values from ('2020-01-01 00:00:00+00') to ('2020-01-02 00:00:00+00');
  perform atlas.tool_log_maintain();
  if to_regclass('atlas.tool_log_p20200101') is not null then raise exception 'FAIL: old partition kept'; end if;
  raise notice 'PASS 7b partitions older than 30 days dropped by atlas.tool_log_maintain()';
  if not exists (select 1 from cron.job where jobname = 'atlas-tool-log-maintain' and schedule = '5 0 * * *') then raise exception 'FAIL: cron job missing'; end if;
  raise notice 'PASS 7c pg_cron job atlas-tool-log-maintain scheduled daily 00:05 UTC';
end $$;

rollback;
