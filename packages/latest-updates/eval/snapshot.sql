-- Freeze query for the latest-updates eval set (#629). READ-ONLY: a single SELECT.
-- Run against Atlas with any read-only role. Returns one jsonb array (`ents`), which is
-- what `snapshot.json` holds under `entities` (sorted by slug, nulls dropped).
-- Window override for freezing only: 72 h on entity_items.created_at, fixed bounds below.
-- The runner never uses this basis; it uses occurred_at and LATEST_UPDATES_WINDOW_HOURS.
-- The slug list is the selection described in README.md (strata A to E).
with params as (
  select timestamptz '2026-11-11 01:00:00+00' as since, timestamptz '2026-11-14 01:00:00+00' as until
),
touched as (
  select i.main_entity_id as entity_id, max(i.created_at) as latest_item_created_at
  from atlas.entity_items i, params p
  where i.status = 'active' and i.created_at >= p.since and i.created_at < p.until
    and i.main_entity_id in (select id from atlas.entities where slug in ('kospi','machi','huobi-htx','vitalik-buterin','russia-ukraine-war','houthi-movement','sp-500','u-s-stocks','zksync','spot-eth-altcoin-etfs','compound-foundation','crude-oil-wti','ai-industry','united-states','apple','cftc','australia','solana','alibaba','bitcoin','binance','bitdeer','hive-digital-technologies','nvidia','adobe','christopher-waller','japan-government-bond-market','blackrock','jensen-huang','microsoft','monetary-authority-of-singapore','hyperscale-data'))
  group by i.main_entity_id
),
new_items as (
  select i.main_entity_id as entity_id, i.id, i.title, i.summary, i.occurred_at, i.created_at, i.signal_id, i.angle, i.note
  from atlas.entity_items i, params p
  where i.status = 'active' and i.created_at >= p.since and i.created_at < p.until
),
prior as (
  select t.entity_id, i.id, i.title, i.summary, i.occurred_at, i.created_at, i.signal_id, i.angle, i.note
  from touched t
  join lateral (
    select * from atlas.entity_items i
    where i.main_entity_id = t.entity_id and i.status = 'active'
      and i.created_at < (select since from params)
    order by coalesce(i.occurred_at, i.created_at) desc, i.id desc
    limit 7
  ) i on true
),
item_rows as (select * from prior union select * from new_items),
origin_signal_ids as (
  select distinct ir.entity_id, x.signal_id
  from item_rows ir
  cross join lateral (
    select s.signal_id from atlas.item_signals s where s.item_id = ir.id and s.role = 'origin'
    union
    select ir.signal_id where ir.signal_id is not null
  ) x
  where x.signal_id is not null
)
select jsonb_agg(entity_json order by latest_item_created_at desc, eid) as ents from (
  select t.latest_item_created_at, e.id as eid,
    jsonb_build_object(
      'id', e.id, 'slug', e.slug, 'name', e.name, 'type', e.type, 'summary', e.summary,
      'new_items', (select coalesce(jsonb_agg(jsonb_build_object(
          'id', n.id, 'title', n.title, 'summary', n.summary, 'occurred_at', n.occurred_at,
          'created_at', n.created_at, 'signal_id', n.signal_id, 'angle', n.angle, 'note', n.note
        ) order by n.created_at desc, n.id desc), '[]'::jsonb) from new_items n where n.entity_id = t.entity_id),
      'last_update', (select jsonb_build_object('id', r.id, 'title', r.title, 'summary', r.summary, 'note', r.note,
          'occurred_at', r.occurred_at, 'created_at', r.created_at)
        from prior r where r.entity_id = t.entity_id
        order by coalesce(r.occurred_at, r.created_at) desc, r.id desc limit 1),
      'prior_items', (select coalesce(jsonb_agg(jsonb_build_object(
          'id', r.id, 'title', r.title, 'summary', r.summary, 'occurred_at', r.occurred_at, 'note', r.note
        ) order by coalesce(r.occurred_at, r.created_at) desc, r.id desc), '[]'::jsonb) from prior r where r.entity_id = t.entity_id),
      'origin_signals', (select coalesce(jsonb_agg(jsonb_build_object(
          'signal_id', s.signal_id, 'source', s.source, 'text', s.text,
          'excerpt', case when s.excerpt is distinct from s.text then s.excerpt end,
          'numbers', s.numbers, 'link', s.link, 'occurred_at', s.occurred_at
        ) order by s.signal_id), '[]'::jsonb)
        from origin_signal_ids o join atlas.signals s on s.signal_id = o.signal_id where o.entity_id = t.entity_id)
    ) as entity_json
  from touched t join atlas.entities e on e.id = t.entity_id
) q
;
