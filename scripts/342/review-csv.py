#!/usr/bin/env python3
"""#342 PR-4: keep/merge/drop review CSV for article-created entities (for #347).
Input: review-export.json (result of review-export.sql, read-only). Output CSV on stdout.
Similarity = pg_trgm similarity on name_key (Python reimplementation, no pg_trgm on prod).
Suggested survivor (CTO rule, #342): catalogue-linked wins (refuse if both are);
then more live items; then older created_at. Nothing is merged: Bucket decides in #347."""
import csv, json, sys
from kinds import kind_v1, compare_key, similarity
HOLD, ATTACH = 0.6, 0.85
rows = json.load(open(sys.argv[1]))
def survivor(a, b):
    if a['catalog_entity_id'] and b['catalog_entity_id']: return None, 'refuse: both catalogue-linked'
    if a['catalog_entity_id'] or b['catalog_entity_id']:
        w = a if a['catalog_entity_id'] else b; return w, 'catalogue-linked'
    if a['live_items'] != b['live_items']:
        w = a if a['live_items'] > b['live_items'] else b; return w, 'more live items'
    w = min(a, b, key=lambda r: (r['created_at'], r['id'])); return w, 'older created_at'
out = csv.writer(sys.stdout)
out.writerow(['entity_id','name','name_key','stored_type','kind_v1','status','live_items','created_at',
  'best_candidate_id','best_candidate_name','best_candidate_items','similarity','legal_suffix_match','other_candidates',
  'suggested_action','suggested_survivor_id','suggested_survivor_name','survivor_reason'])
n = 0
for r in rows:
    if not r['article_created']: continue
    n += 1
    ck = compare_key(r['name'])
    cands = []
    for o in rows:
        if o['id'] == r['id'] or not o['name_key'] or not r['name_key']: continue
        sim = similarity(r['name_key'], o['name_key']); sfx = ck != '' and ck == compare_key(o['name'])
        if sim >= HOLD or sfx: cands.append((1.0 if sfx else sim, sim, sfx, o))
    cands.sort(key=lambda c: (-c[0], c[3]['id']))
    best = cands[0] if cands else None
    if best and best[0] >= ATTACH: action = 'merge'
    elif best: action = 'review'
    elif r['live_items'] == 0: action = 'drop'
    else: action = 'keep'
    surv, reason = (survivor(r, best[3]) if best else (None, ''))
    out.writerow([r['id'], r['name'], r['name_key'], r['type'], kind_v1(r['type']), r['status'], r['live_items'], r['created_at'],
      best[3]['id'] if best else '', best[3]['name'] if best else '', best[3]['live_items'] if best else '',
      f'{best[1]:.3f}' if best else '', 'yes' if best and best[2] else '',
      '; '.join(f"{c[3]['name']} ({c[1]:.2f})" for c in cands[1:6]),
      action, surv['id'] if surv else '', surv['name'] if surv else '', reason])
print(f'rows={n}', file=sys.stderr)
