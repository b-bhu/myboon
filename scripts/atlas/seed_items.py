#!/usr/bin/env python3
"""#441 follow-up: seed atlas.entity_items from cleanup.sqlite (final pass Oct 25).

Read-only on the source. Scope: items whose head status = 'active' (1989).
- item_key       = source item id (stable; upsert key)
- title/summary  = article_items.title / timeline_summary; note-only items: first sentence of note / note
- occurred_at    = coalesce(article event_at, published_at); null for note-only items
- main entity    = the single live membership with role in (primary, primary_subject) -> atlas.entities.legacy_entity_id;
                   if none, the single live `subject` membership (CTO, Oct 25)
Items with 2+ main memberships, or no main and not exactly one subject, are NOT seeded (no guessing); they are written to
<out_dir>/unresolved.tsv for review.

Each batch: one transaction, lock_timeout 5s, atlas.reason set (history via trigger).
Items upsert on item_key and only update when a value differs.
Entities are resolved inside the DB via legacy_entity_id, so a row whose entity is missing is skipped,
never inserted with a guess. A rerun changes 0 rows and writes 0 history rows.

Per-item overrides (CTO picks, Oct 25): scripts/atlas/main_entity_picks_oct25.tsv
(item_id, main_entity_slug, drop, reason). A picked item uses the picked main entity
(the junction table is dropped, #541, so picks carry no side entities). drop = yes keeps the item out of Atlas.

usage: seed_items.py <cleanup.sqlite> <out_dir> [batch_size] [picks.tsv]
"""
import csv, re, sqlite3, sys, pathlib
from collections import defaultdict

MAIN = {'primary', 'primary_subject'}
ALSO = {'related', 'subject', 'commentator'}

def lit(v):
    return 'null' if v is None else "'" + str(v).replace("'", "''") + "'"

def note_title(note):
    s = re.split(r'(?<=[.!?])\s', note.strip(), maxsplit=1)[0]
    return s if len(s) <= 200 else s[:197].rsplit(' ', 1)[0] + '...'

def main():
    db, out = sys.argv[1], pathlib.Path(sys.argv[2])
    size = int(sys.argv[3]) if len(sys.argv) > 3 else 200
    picks_path = sys.argv[4] if len(sys.argv) > 4 else pathlib.Path(__file__).with_name('main_entity_picks_oct25.tsv')
    out.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
    active_ents = {r[0] for r in c.execute(
        "select id from managed_knowledge_private__entities where status = 'active'")}
    slug_id = dict(c.execute(
        "select slug, id from managed_knowledge_private__entities where status = 'active'"))
    picks = {}
    for r in csv.DictReader(open(picks_path), delimiter='\t'):
        assert r['item_id'] not in picks, r['item_id']
        assert r['drop'] in ('yes', 'no'), r
        if r['drop'] == 'yes':
            picks[r['item_id']] = None
        else:
            main = slug_id[r['main_entity_slug'].strip()]
            picks[r['item_id']] = main
    items = c.execute("""
        select h.item_id, a.title, a.timeline_summary, coalesce(a.event_at, a.published_at), i.note
        from managed_knowledge_private__item_heads h
        join managed_knowledge_private__items i on i.id = h.item_id
        left join managed_knowledge_private__article_items a on a.item_id = h.item_id
        where h.status = 'active' order by h.item_id""").fetchall()
    mem = defaultdict(list)
    for item_id, ent, role in c.execute("""select item_id, entity_id, role from managed_knowledge_private__memberships
                                           where removed_operation is null"""):
        mem[item_id].append((ent, role))
    rows, unresolved = [], []
    n_subj = n_pick = 0
    dropped = []
    for item_id, title, summ, occ, note in items:
        ms = mem.get(item_id, [])
        if item_id in picks:
            if picks[item_id] is None:
                dropped.append(item_id)
                continue
            if title is None:
                title, summ = note_title(note), note
            main = picks[item_id]
            n_pick += 1
            rows.append(f"({lit(item_id)},{lit(title)},{lit(summ)},{lit(occ)}::timestamptz,{lit(main)}::uuid)")
            continue
        mains = sorted({e for e, r in ms if r in MAIN})
        subj = sorted({e for e, r in ms if r == 'subject'})
        via_subject = not mains and len(subj) == 1
        if via_subject:
            mains = subj
        bad = [e for e, _ in ms if e not in active_ents]
        if len(mains) != 1 or bad:
            reason = ('inactive_entity' if bad else 'no_membership' if not ms
                      else 'multiple_main' if len(mains) > 1
                      else 'multiple_subject_no_main' if subj else 'no_main_or_subject')
            cands = ';'.join(f'{e}:{r}' for e, r in sorted(set(ms)))
            unresolved.append((item_id, reason, cands or '-',
                               (title or (note and note_title(note)) or '')[:160].replace('\t', ' ').replace('\n', ' ')))
            continue
        if title is None:
            title, summ = note_title(note), note
        assert title, item_id
        n_subj += via_subject
        rows.append(f"({lit(item_id)},{lit(title)},{lit(summ)},{lit(occ)}::timestamptz,{lit(mains[0])}::uuid)")
        assert {r for _, r in ms} <= MAIN | ALSO, (item_id, ms)
    assert set(picks) <= {i[0] for i in items}, 'pick for an unknown/inactive item'
    (out / 'dropped.txt').write_text(''.join(d + '\n' for d in dropped))
    with open(out / 'unresolved.tsv', 'w') as f:
        f.write('item_id\treason\tcandidates(entity_id:role)\ttitle\n')
        for u in unresolved:
            f.write('\t'.join(map(str, u)) + '\n')
    n = 0
    for i in range(0, len(rows), size):
        n += 1
        body = ',\n'.join(rows[i:i + size])
        sql = f"""-- atlas.entity_items seed batch {n} ({len(rows[i:i+size])} items), #441, source cleanup.sqlite final pass Oct 25
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
set local atlas.reason = 'seed #441 items from cleanup.sqlite final pass (cleanup-2026-10-25)';
insert into atlas.entity_items as t (item_key, title, summary, occurred_at, main_entity_id)
select v.item_key, v.title, v.summary, v.occurred_at, sh.id
from (values
{body}
) v(item_key, title, summary, occurred_at, entity_id)
join atlas.entities sh on sh.legacy_entity_id = v.entity_id
on conflict (item_key) do update set
  title = excluded.title, summary = excluded.summary, occurred_at = excluded.occurred_at,
  main_entity_id = excluded.main_entity_id, updated_at = now()
where (t.title, t.summary, t.occurred_at, t.main_entity_id)
  is distinct from (excluded.title, excluded.summary, excluded.occurred_at, excluded.main_entity_id);
commit;
"""
        (out / f'batch_{n:02d}.sql').write_text(sql)
    print(f'{len(items)} active items: {len(rows)} seedable ({n_subj} via single subject, {n_pick} via picks), {len(dropped)} dropped, '
          f'{len(unresolved)} unresolved -> {n} batches in {out}')

if __name__ == '__main__':
    main()