#!/usr/bin/env python3
"""#441 follow-up: seed atlas.items + atlas.item_shelves (also_affects) from cleanup.sqlite (final pass Oct 25).

Read-only on the source. Scope: items whose head status = 'active' (1989).
- item_key       = source item id (stable; upsert key)
- title/summary  = article_items.title / timeline_summary; note-only items: first sentence of note / note
- occurred_at    = coalesce(article event_at, published_at); null for note-only items
- main shelf     = the single live membership with role in (primary, primary_subject) -> atlas.shelves.legacy_entity_id;
                   if none, the single live `subject` membership (CTO, Oct 25)
- also_affects   = other live memberships (related, subject, commentator), excluding the main shelf
Items with 2+ main memberships, or no main and not exactly one subject, are NOT seeded (no guessing); they are written to
<out_dir>/unresolved.tsv for review.

Each batch: one transaction, lock_timeout 5s, atlas.reason set (history via trigger).
Items upsert on item_key and only update when a value differs; links insert on conflict do nothing.
Shelves are resolved inside the DB via legacy_entity_id, so a row whose shelf is missing is skipped,
never inserted with a guess. A rerun changes 0 rows and writes 0 history rows.

usage: seed_items.py <cleanup.sqlite> <out_dir> [batch_size]
"""
import re, sqlite3, sys, pathlib
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
    out.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
    active_ents = {r[0] for r in c.execute(
        "select id from managed_knowledge_private__entities where status = 'active'")}
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
    rows, links, unresolved = [], [], []
    n_subj = 0
    for item_id, title, summ, occ, note in items:
        ms = mem.get(item_id, [])
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
        for e in sorted({e for e, r in ms if r in ALSO and e != mains[0]}):
            links.append((len(rows) - 1, f"({lit(item_id)},{lit(e)}::uuid)"))
        assert {r for _, r in ms} <= MAIN | ALSO, (item_id, ms)
    with open(out / 'unresolved.tsv', 'w') as f:
        f.write('item_id\treason\tcandidates(entity_id:role)\ttitle\n')
        for u in unresolved:
            f.write('\t'.join(map(str, u)) + '\n')
    n = 0
    for i in range(0, len(rows), size):
        n += 1
        body = ',\n'.join(rows[i:i + size])
        lk = [l for idx, l in links if i <= idx < i + size]
        link_sql = ''
        if lk:
            link_sql = f"""insert into atlas.item_shelves (item_id, shelf_id, role)
select it.id, sh.id, 'also_affects'
from (values
{',\n'.join(lk)}
) v(item_key, entity_id)
join atlas.items it on it.item_key = v.item_key
join atlas.shelves sh on sh.legacy_entity_id = v.entity_id
on conflict (item_id, shelf_id, role) do nothing;
"""
        sql = f"""-- atlas.items seed batch {n} ({len(rows[i:i+size])} items, {len(lk)} also_affects links), #441, source cleanup.sqlite final pass Oct 25
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
set local atlas.reason = 'seed #441 items from cleanup.sqlite final pass (cleanup-2026-10-25)';
insert into atlas.items as t (item_key, title, summary, occurred_at, main_shelf_id)
select v.item_key, v.title, v.summary, v.occurred_at, sh.id
from (values
{body}
) v(item_key, title, summary, occurred_at, entity_id)
join atlas.shelves sh on sh.legacy_entity_id = v.entity_id
on conflict (item_key) do update set
  title = excluded.title, summary = excluded.summary, occurred_at = excluded.occurred_at,
  main_shelf_id = excluded.main_shelf_id, updated_at = now()
where (t.title, t.summary, t.occurred_at, t.main_shelf_id)
  is distinct from (excluded.title, excluded.summary, excluded.occurred_at, excluded.main_shelf_id);
{link_sql}commit;
"""
        (out / f'batch_{n:02d}.sql').write_text(sql)
    print(f'{len(items)} active items: {len(rows)} seedable ({n_subj} via single subject), {len(links)} also_affects links, '
          f'{len(unresolved)} unresolved -> {n} batches in {out}')

if __name__ == '__main__':
    main()
