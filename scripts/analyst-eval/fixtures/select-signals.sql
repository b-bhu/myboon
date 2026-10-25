-- Read-only selection for #442 (run Oct 25, 2026). 50 entities chosen by md5(entity_id),
-- one article each (<= 2 per entity), event_at in [2026-09-13, 2026-09-28).
with w as (
  select id, entity_id, source, source_ref_id, title, summary, event_at, observed_at,
         row_number() over (partition by entity_id order by md5(id::text)) rn
  from public.entity_memories
  where source_type = 'article' and event_at >= '2026-09-13' and event_at < '2026-09-28'
    and source_ref_id is not null and title is not null
), e as (select entity_id from w where rn = 1 order by md5(entity_id::text) limit 50)
select w.* from w join e using (entity_id) where w.rn = 1 order by md5(w.entity_id::text);
