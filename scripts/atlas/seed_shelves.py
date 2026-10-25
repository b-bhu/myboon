#!/usr/bin/env python3
"""#441: seed atlas.shelves from the finalized entity copy (cleanup.sqlite, final pass Oct 25).

Reads managed_knowledge_private__entities where status = 'active' (558 rows), read-only.
Writes one SQL file per batch. Each batch is an upsert keyed on the natural key `slug`;
it only updates when a value differs, so a rerun changes 0 rows (and writes 0 history rows).

usage: seed_shelves.py <cleanup.sqlite> <out_dir> [batch_size]
"""
import json, sqlite3, sys, pathlib

TYPES = {'organization','asset','protocol','person','topic','place','event','product','regulation'}

def lit(v):
    if v is None:
        return 'null'
    return "'" + str(v).replace("'", "''") + "'"

def main():
    db, out = sys.argv[1], pathlib.Path(sys.argv[2])
    size = int(sys.argv[3]) if len(sys.argv) > 3 else 100
    out.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
    rows = c.execute("""select id, slug, name, type, aliases, summary, metadata
                        from managed_knowledge_private__entities
                        where status = 'active' order by slug""").fetchall()
    vals = []
    for id_, slug, name, type_, aliases, summary, meta in rows:
        assert type_ in TYPES, (slug, type_)
        al = json.loads(aliases or '[]')
        card = (json.loads(meta) if meta else {}).get('card')
        arr = 'array[' + ','.join(lit(a) for a in al) + ']::text[]' if al else "'{}'::text[]"
        vals.append(f"({lit(slug)},{lit(name)},{lit(type_)},{arr},{lit(summary)},"
                    f"{lit(json.dumps(card, sort_keys=True)) + '::jsonb' if card is not None else 'null::jsonb'},{lit(id_)}::uuid)")
    n = 0
    for i in range(0, len(vals), size):
        n += 1
        body = ',\n'.join(vals[i:i + size])
        sql = f"""-- atlas.shelves seed batch {n} ({len(vals[i:i+size])} rows), #441, source cleanup.sqlite final pass Oct 25
begin;
set local lock_timeout = '5s';
set local atlas.reason = 'seed #441 from cleanup.sqlite final pass (cleanup-2026-10-25)';
insert into atlas.shelves as s (slug, name, type, aliases, summary, card, legacy_entity_id)
values
{body}
on conflict (slug) do update set
  name = excluded.name, type = excluded.type, aliases = excluded.aliases,
  summary = excluded.summary, card = excluded.card, legacy_entity_id = excluded.legacy_entity_id
where (s.name, s.type, s.aliases, s.summary, s.card, s.legacy_entity_id)
  is distinct from (excluded.name, excluded.type, excluded.aliases, excluded.summary, excluded.card, excluded.legacy_entity_id);
commit;
"""
        (out / f'batch_{n:02d}.sql').write_text(sql)
    print(f'{len(vals)} active entities -> {n} batches in {out}')

if __name__ == '__main__':
    main()
