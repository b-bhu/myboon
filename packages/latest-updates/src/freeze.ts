/**
 * EVAL-ONLY. The freeze query for a new eval set, with the window override the runner must never have: a window
 * length and a basis (`created_at` or `occurred_at`) chosen by the person freezing (for example 72 h on
 * `created_at`, so the entity manager's lag from #621 does not leave the set thin). Nothing in the runner
 * (store.ts, runner.ts, entry.ts, run.ts) imports this file; a test pins that.
 *
 * Prints a single read-only SELECT. Run it against Atlas with any read-only role, then save the result as a NEW
 * dated set under packages/latest-updates/eval/ (never regenerate snapshot.json in place).
 */
export type FreezeBasis = 'created_at' | 'occurred_at';
export type FreezeOptions = { basis: FreezeBasis; hours: number; until: string; slugs?: string[] };

export function freezeSql(o: FreezeOptions): string {
  if (o.basis !== 'created_at' && o.basis !== 'occurred_at') throw new Error("basis must be 'created_at' or 'occurred_at'");
  if (!Number.isInteger(o.hours) || o.hours < 1 || o.hours > 24 * 30) throw new Error('hours must be a whole number from 1 to 720');
  const until = new Date(o.until);
  if (Number.isNaN(until.getTime())) throw new Error('until must be an ISO date-time');
  const slugs = o.slugs ?? [];
  for (const s of slugs) if (!/^[a-z0-9][a-z0-9_-]*$/.test(s)) throw new Error('slugs may only hold a-z, 0-9, - and _');
  const col = o.basis;
  const slugFilter = slugs.length ? `\n    and i.main_entity_id in (select id from atlas.entities where slug in (${slugs.map((s) => `'${s}'`).join(',')}))` : '';
  return `-- EVAL-ONLY freeze query: a single read-only SELECT. Window override: ${o.hours} h on entity_items.${col}. The runner never uses this.
with params as (
  select timestamptz '${until.toISOString()}' - interval '${o.hours} hours' as since, timestamptz '${until.toISOString()}' as until
),
touched as (
  select i.main_entity_id as entity_id, max(i.${col}) as latest_item_at
  from atlas.entity_items i, params p
  where i.status = 'active' and i.${col} >= p.since and i.${col} < p.until${slugFilter}
  group by i.main_entity_id
),
new_items as (
  select i.main_entity_id as entity_id, i.id, i.title, i.summary, i.occurred_at, i.created_at, i.signal_id, i.angle, i.note
  from atlas.entity_items i, params p
  where i.status = 'active' and i.${col} >= p.since and i.${col} < p.until
),
prior as (
  select t.entity_id, i.id, i.title, i.summary, i.occurred_at, i.created_at, i.signal_id, i.angle, i.note
  from touched t
  join lateral (
    select * from atlas.entity_items i
    where i.main_entity_id = t.entity_id and i.status = 'active' and i.${col} < (select since from params)
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
select jsonb_agg(entity_json order by latest_item_at desc, eid) as ents from (
  select t.latest_item_at, e.id as eid,
    jsonb_build_object(
      'id', e.id, 'slug', e.slug, 'name', e.name, 'type', e.type, 'summary', e.summary,
      'new_items', (select coalesce(jsonb_agg(jsonb_build_object(
          'id', n.id, 'title', n.title, 'summary', n.summary, 'occurred_at', n.occurred_at,
          'created_at', n.created_at, 'signal_id', n.signal_id, 'angle', n.angle, 'note', n.note
        ) order by n.${col} desc, n.id desc), '[]'::jsonb) from new_items n where n.entity_id = t.entity_id),
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
`;
}
