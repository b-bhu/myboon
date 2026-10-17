-- #337 PR-A check for 20261017120000_managed_entity_columns.sql.
-- Run ONLY against a disposable database that has every migration applied
-- (including 20261017120000, after its preseed committed), as a superuser
-- (it uses SET SESSION AUTHORIZATION to call the readers as the dedicated
-- research login). Everything runs in one transaction and is rolled back.
-- Any failed expectation raises and aborts.
\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE c337(k text PRIMARY KEY, v jsonb);
GRANT ALL ON c337 TO myboon_v4_research;

-- 1. entity_name_key_v1 equals the TS entityIdentityKey on every fixture.
DO $namekey$
DECLARE fixture record; got text;
BEGIN
  FOR fixture IN SELECT * FROM (VALUES
    ('Bitcoin (BTC)','bitcoin'),
    ('  BITCOIN ','bitcoin'),
    ('Bitcoin ETF','bitcoinetf'),
    ('bitcoin-etf','bitcoinetf'),
    ('U.S.–Iran Conflict','usiranconflict'),
    ('(BTC)','btc'),
    ('',''),
    ('Bitcoin (BTC) (ETF)','bitcoinbtc'),
    ('Société Générale','sociétégénérale'),
    ('ＢＴＣ','btc'),
    ('Federal Reserve (Fed)','federalreserve'),
    ('  Solana   (SOL) ','solana'),
    ('AT&T','att'),
    ('Zürich','zürich'),
    ('İstanbul','istanbul')
  ) AS fixtures(value,expected) LOOP
    got := managed_knowledge_private.entity_name_key_v1(fixture.value);
    IF got IS DISTINCT FROM fixture.expected THEN
      RAISE EXCEPTION 'name_key(%) = %, expected %',fixture.value,got,fixture.expected;
    END IF;
  END LOOP;
  IF managed_knowledge_private.entity_name_key_v1(NULL) IS DISTINCT FROM '' THEN
    RAISE EXCEPTION 'name_key(NULL) must be the empty string';
  END IF;
END
$namekey$;

-- 2. Columns exist with the required NOT NULL rails and no image/tag columns.
DO $columns$
DECLARE attribute record;
BEGIN
  FOR attribute IN
    SELECT name,required FROM (VALUES
      ('name',true),('slug',true),('type',true),('aliases',true),('summary',false),
      ('status',true),('show_in_carousel',true),('metadata',true),('updated_at',true),('name_key',false)
    ) AS wanted(name,required)
  LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid='managed_knowledge_private.entities'::regclass
      AND attname=attribute.name AND NOT attisdropped AND attnum > 0) THEN
      RAISE EXCEPTION 'column % is missing from managed entities',attribute.name;
    END IF;
    IF attribute.required AND (SELECT attnotnull FROM pg_catalog.pg_attribute WHERE attrelid='managed_knowledge_private.entities'::regclass
      AND attname=attribute.name AND NOT attisdropped AND attnum > 0) = false THEN
      RAISE EXCEPTION 'column % must be NOT NULL',attribute.name;
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid='managed_knowledge_private.entities'::regclass
    AND attnum > 0 AND NOT attisdropped AND attname ~ '^(image|image_url|tag|tags)$') THEN
    RAISE EXCEPTION 'managed entities must not carry image or tag columns';
  END IF;
END
$columns$;

-- 3. Preseeded rows: linked row reads as the catalogue identity, article-only
--    row as its binding, and name_key derives from the name column.
DO $preseed$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM managed_knowledge_private.entities WHERE id='00000000-0000-4000-8000-00000000e337';
  IF r.name IS DISTINCT FROM 'Ethereum' OR r.slug IS DISTINCT FROM 'ethereum-337' OR r.type IS DISTINCT FROM 'network'
    OR r.aliases IS DISTINCT FROM '["ETH"]'::jsonb OR r.summary IS DISTINCT FROM 'catalog summary' OR r.status IS DISTINCT FROM 'active'
    OR r.show_in_carousel IS NOT TRUE OR r.metadata->>'imageUrl' IS DISTINCT FROM 'https://example.test/eth.png'
    OR r.name_key IS DISTINCT FROM 'ethereum' THEN
    RAISE EXCEPTION 'linked managed row did not take the catalogue identity: %',to_jsonb(r);
  END IF;
  IF r.updated_at IS DISTINCT FROM (SELECT updated_at FROM public.entities WHERE id='00000000-0000-4000-8000-000000000337') THEN
    RAISE EXCEPTION 'linked managed row updated_at must come from the catalogue';
  END IF;
  SELECT * INTO r FROM managed_knowledge_private.entities WHERE id='00000000-0000-4000-8000-00000000a337';
  IF r.name IS DISTINCT FROM 'Preseed 337 (P337)' OR r.slug IS DISTINCT FROM 'preseed-337' OR r.type IS DISTINCT FROM 'topic'
    OR r.aliases IS DISTINCT FROM '["P337"]'::jsonb OR r.summary IS DISTINCT FROM 'binding summary' OR r.status IS DISTINCT FROM 'active'
    OR r.show_in_carousel IS NOT FALSE OR r.metadata IS DISTINCT FROM '{"articleCreated":true}'::jsonb
    OR r.name_key IS DISTINCT FROM 'preseed337' THEN
    RAISE EXCEPTION 'article-only managed row did not take its binding identity: %',to_jsonb(r);
  END IF;
END
$preseed$;

-- 4. A writer-shaped INSERT (binding only) is filled by the trigger.
INSERT INTO managed_knowledge_private.entities(id,identity_key,catalog_entity_id,binding,created_operation)
  VALUES('00000000-0000-4000-8000-00000000f337','article:topic:bound 337',NULL,
    '{"name":"Bound 337 (B337)","slug":"bound-337","type":"topic","aliases":["B337"],"metadata":{"probe":true}}'::jsonb,
    'progression-v2:' || repeat('b',64));
DO $trigger_fill$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM managed_knowledge_private.entities WHERE id='00000000-0000-4000-8000-00000000f337';
  IF r.name IS DISTINCT FROM 'Bound 337 (B337)' OR r.slug IS DISTINCT FROM 'bound-337' OR r.type IS DISTINCT FROM 'topic'
    OR r.aliases IS DISTINCT FROM '["B337"]'::jsonb OR r.summary IS NOT NULL OR r.status IS DISTINCT FROM 'active'
    OR r.show_in_carousel IS NOT FALSE OR r.metadata IS DISTINCT FROM '{"probe":true}'::jsonb
    OR r.updated_at IS NULL OR r.name_key IS DISTINCT FROM 'bound337' THEN
    RAISE EXCEPTION 'fill trigger did not populate the columns from binding: %',to_jsonb(r);
  END IF;
END
$trigger_fill$;

-- 5. entity_revision_v1 digests the private columns; stale plans are held, and
--    a non-active status answers 'unavailable'.
DO $revision$
DECLARE row_id uuid := '00000000-0000-4000-8000-00000000a337';
  old_revision text; new_revision text; expected text;
BEGIN
  old_revision := managed_knowledge_private.entity_revision_v1(row_id);
  SELECT 'managed:' || revision::text || ':' || managed_knowledge_private.digest_v1(jsonb_build_object(
      'slug',slug,'name',name,'type',type,'aliases',aliases,'summary',summary,'status',status,
      'show_in_carousel',show_in_carousel,'metadata',metadata,'updated_at',updated_at))
    INTO expected FROM managed_knowledge_private.entities WHERE id=row_id;
  IF old_revision IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'entity_revision_v1 must digest the private columns: got %, expected %',old_revision,expected;
  END IF;
  UPDATE managed_knowledge_private.entities SET summary='hold summary 337' WHERE id=row_id;
  new_revision := managed_knowledge_private.entity_revision_v1(row_id);
  IF new_revision IS NOT DISTINCT FROM old_revision THEN
    RAISE EXCEPTION 'the revision string must change when a column changes';
  END IF;
  IF managed_knowledge_private.targets_current_v1(jsonb_build_object(row_id::text,old_revision),NULL) THEN
    RAISE EXCEPTION 'the old revision must fail targets_current_v1';
  END IF;
  IF NOT managed_knowledge_private.targets_current_v1(jsonb_build_object(row_id::text,new_revision),NULL) THEN
    RAISE EXCEPTION 'the new revision must pass targets_current_v1';
  END IF;
  PERFORM set_config('myboon.check_337_new_revision',new_revision,true);
  UPDATE managed_knowledge_private.entities SET status='retired' WHERE id=row_id;
  IF managed_knowledge_private.entity_revision_v1(row_id) IS DISTINCT FROM 'unavailable' THEN
    RAISE EXCEPTION 'a retired managed entity must answer unavailable';
  END IF;
  UPDATE managed_knowledge_private.entities SET status='active' WHERE id=row_id;
END
$revision$;
INSERT INTO c337
  SELECT 'managed_revision',to_jsonb(current_setting('myboon.check_337_new_revision'));

-- 6. A row linked AFTER the migration keeps the real catalogue identity: the
--    fill trigger takes still-NULL columns from the catalogue row, so the
--    binding's catalog-only branch (show_in_carousel:false) does not win.
INSERT INTO public.entities(id,slug,name,type,aliases,summary,status,show_in_carousel,metadata)
  VALUES('00000000-0000-4000-8000-00000000c337','carousel-337','Carousel 337','topic','[]'::jsonb,'carousel catalogue summary','active',true,'{}'::jsonb);
INSERT INTO managed_knowledge_private.entities(id,identity_key,catalog_entity_id,binding,created_operation)
  SELECT e.id,'catalog:' || e.id::text,e.id,
    jsonb_build_object('id',e.id,'slug',e.slug,'name',e.name,'type',e.type,'aliases',e.aliases,
      'summary',e.summary,'status',e.status,'show_in_carousel',false,'metadata',e.metadata,
      'created_at',e.created_at,'updated_at',e.updated_at,'revision','catalog:check337',
      'catalogEntityId',e.id,'identityKey','catalog:' || e.id::text)
    FROM public.entities e WHERE e.id='00000000-0000-4000-8000-00000000c337';
DO $carousel_link$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM managed_knowledge_private.entities WHERE id='00000000-0000-4000-8000-00000000c337';
  IF r.name IS DISTINCT FROM 'Carousel 337' OR r.slug IS DISTINCT FROM 'carousel-337' OR r.type IS DISTINCT FROM 'topic'
    OR r.aliases IS DISTINCT FROM '[]'::jsonb OR r.summary IS DISTINCT FROM 'carousel catalogue summary'
    OR r.status IS DISTINCT FROM 'active' OR r.show_in_carousel IS NOT TRUE OR r.metadata IS DISTINCT FROM '{}'::jsonb
    OR r.updated_at IS DISTINCT FROM (SELECT updated_at FROM public.entities WHERE id='00000000-0000-4000-8000-00000000c337') THEN
    RAISE EXCEPTION 'a row linked after the migration must take the catalogue identity (carousel flag included): %',to_jsonb(r);
  END IF;
END
$carousel_link$;

-- 7. A JSON null aliases binding stores []; any other non-array value stays
--    untouched for the CHECK to reject.
INSERT INTO managed_knowledge_private.entities(id,identity_key,catalog_entity_id,binding,created_operation)
  VALUES('00000000-0000-4000-8000-000000002337','article:topic:null-aliases-337',NULL,
    '{"name":"Null Aliases 337","slug":"null-aliases-337","type":"topic","aliases":null}'::jsonb,
    'progression-v2:' || repeat('b',64));
DO $null_aliases$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM managed_knowledge_private.entities WHERE id='00000000-0000-4000-8000-000000002337';
  IF r.aliases IS DISTINCT FROM '[]'::jsonb THEN
    RAISE EXCEPTION 'a JSON null aliases binding must store []: %',r.aliases;
  END IF;
END
$null_aliases$;

-- 8. A non-array aliases binding (a JSON string) is rejected by
--    managed_entities_aliases_array.
DO $string_aliases$
DECLARE rejected boolean := false;
BEGIN
  BEGIN
    INSERT INTO managed_knowledge_private.entities(id,identity_key,catalog_entity_id,binding,created_operation)
      VALUES('00000000-0000-4000-8000-00000000d337','article:topic:not-array-337',NULL,
        '{"name":"Not Array 337","slug":"not-array-337","type":"topic","aliases":"not-an-array"}'::jsonb,
        'progression-v2:' || repeat('b',64));
  EXCEPTION WHEN check_violation THEN rejected := true;
  END;
  IF NOT rejected THEN
    RAISE EXCEPTION 'a non-array aliases binding must fail with check_violation on managed_entities_aliases_array';
  END IF;
END
$string_aliases$;

-- 9. A binding whose derived ASCII slug is empty (a non-ASCII name) falls back
--    to 'entity-' || id without dashes.
INSERT INTO managed_knowledge_private.entities(id,identity_key,catalog_entity_id,binding,created_operation)
  VALUES('00000000-0000-4000-8000-000000001337','article:topic:greek-337',NULL,
    '{"name":"Ελλάδα","type":"topic","aliases":[]}'::jsonb,'progression-v2:' || repeat('b',64));
DO $greek_slug$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM managed_knowledge_private.entities WHERE id='00000000-0000-4000-8000-000000001337';
  IF r.slug IS DISTINCT FROM 'entity-' || replace('00000000-0000-4000-8000-000000001337'::text,'-','') THEN
    RAISE EXCEPTION 'a non-ASCII name without a slug must fall back to entity-<id without dashes>: %',r.slug;
  END IF;
END
$greek_slug$;

-- 10. The readers answer from the columns, not the stored binding or the
--    public catalogue: give the linked row a column-only summary first.
UPDATE managed_knowledge_private.entities SET summary='column summary 337' WHERE id='00000000-0000-4000-8000-00000000e337';
SET SESSION AUTHORIZATION myboon_v4_research;
INSERT INTO c337 VALUES
  ('by_alias',managed_knowledge_private.context_v1('{"source":"news","labels":["P337"],"sourceRefs":[],"entityIds":[],"itemIds":[]}')),
  ('by_name',managed_knowledge_private.context_v1('{"source":"news","labels":["Preseed 337 (P337)"],"sourceRefs":[],"entityIds":[],"itemIds":[]}')),
  ('by_ethereum',managed_knowledge_private.context_v1('{"source":"news","labels":["Ethereum"],"sourceRefs":[],"entityIds":[],"itemIds":[]}')),
  ('article_identity',managed_knowledge_private.article_context_v1('{"source":"news","labels":["Ethereum"],"sourceRefs":[],"entityIds":[],"itemIds":[],"identityOnly":true,"historyMode":"targeted"}'));
RESET SESSION AUTHORIZATION;

DO $readers$
DECLARE r jsonb; entity jsonb; new_revision text;
BEGIN
  new_revision := (SELECT v#>>'{}' FROM c337 WHERE k='managed_revision');
  SELECT v INTO r FROM c337 WHERE k='by_alias';
  IF coalesce((SELECT count(*) FROM jsonb_array_elements(r->'entities') x WHERE x->>'id'='00000000-0000-4000-8000-00000000a337'),0) <> 1 THEN
    RAISE EXCEPTION 'context_v1 by alias must return the article-only entity: %',r->'entities';
  END IF;
  SELECT value INTO entity FROM jsonb_array_elements(r->'entities') WHERE value->>'id'='00000000-0000-4000-8000-00000000a337';
  IF entity->>'summary' IS DISTINCT FROM 'hold summary 337' THEN
    RAISE EXCEPTION 'context_v1 must return the column summary, not the binding: %',entity->>'summary';
  END IF;
  IF entity->>'show_in_carousel' IS NOT DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'context_v1 must return the column carousel flag: %',entity->'show_in_carousel';
  END IF;
  SELECT v INTO r FROM c337 WHERE k='by_name';
  SELECT value INTO entity FROM jsonb_array_elements(r->'entities') WHERE value->>'id'='00000000-0000-4000-8000-00000000a337';
  IF entity IS NULL OR entity->>'name' IS DISTINCT FROM 'Preseed 337 (P337)' OR entity->>'summary' IS DISTINCT FROM 'hold summary 337' THEN
    RAISE EXCEPTION 'context_v1 by name must match and answer the columns: %',entity;
  END IF;
  IF entity->>'revision' IS DISTINCT FROM new_revision THEN
    RAISE EXCEPTION 'context_v1 must carry the current column-digest revision';
  END IF;
  SELECT v INTO r FROM c337 WHERE k='by_ethereum';
  SELECT value INTO entity FROM jsonb_array_elements(r->'entities') WHERE value->>'id'='00000000-0000-4000-8000-00000000e337';
  IF entity IS NULL OR entity->>'name' IS DISTINCT FROM 'Ethereum' OR entity->>'summary' IS DISTINCT FROM 'column summary 337'
    OR entity->>'show_in_carousel' IS DISTINCT FROM 'true' OR entity->'metadata'->>'imageUrl' IS DISTINCT FROM 'https://example.test/eth.png' THEN
    RAISE EXCEPTION 'context_v1 must return the linked row columns (not the catalogue or binding): %',entity;
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(r->'entities') x WHERE x->>'name'='Ethereum (stale)') THEN
    RAISE EXCEPTION 'context_v1 must not surface the stale stored binding';
  END IF;
  SELECT v INTO r FROM c337 WHERE k='article_identity';
  SELECT value INTO entity FROM jsonb_array_elements(r->'entities') WHERE value->>'id'='00000000-0000-4000-8000-00000000e337';
  IF entity IS NULL OR entity->>'summary' IS DISTINCT FROM 'column summary 337' OR entity->>'show_in_carousel' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'article_context_v1 identityOnly must return column values for the linked row: %',entity;
  END IF;
  RAISE NOTICE 'check 337 ok: name_key %, columns initialized, trigger fill, column-digest revision % (old one not current), readers answer from columns',
    managed_knowledge_private.entity_name_key_v1('Bitcoin (BTC)'),(SELECT v#>>'{}' FROM c337 WHERE k='managed_revision');
END
$readers$;
ROLLBACK;