#!/usr/bin/env python3
"""#342 PR-4: read-only reclassification CSV for the entity_identity_grounding hold operations.
Input: holds-export.json (holds-export.sql). It does NOT re-run grounding (that needs the
saved Research packet and the model); it re-derives each operation's target items' live
entities under ENTITY_KIND_V1 and suggests a class. No hold is changed."""
import csv, json, sys
from collections import defaultdict
from kinds import kind_v1
e = json.load(open(sys.argv[1]))
mem = defaultdict(list)
for m in e['memberships']: mem[m['item_id']].append(m)
out = csv.writer(sys.stdout)
out.writerow(['operation_id','holds','first_hold','last_hold','target_items','live_entities','kinds_v1','certain_typed_entities','suggested_class','reason'])
for op in e['ops']:
    ms = [m for t in op['targets'] for m in mem.get(t, [])]
    kinds = sorted({kind_v1(m['type']) for m in ms})
    certain = [m for m in ms if not m['uncertain'] and kind_v1(m['type']) != 'unclassified']
    if not ms: cls, why = 'still_held', 'no target item has a live entity membership'
    elif certain: cls, why = 'regroundable', f'{len({m["entity_id"] for m in certain})} certain entities with a v1 kind now exist for its items'
    else: cls, why = 'needs_review', 'targets only have uncertain or unclassified entities'
    out.writerow([op['operation_id'], op['holds'], op['first_hold'], op['last_hold'], len(op['targets']),
      '; '.join(sorted({f"{m['name']} [{kind_v1(m['type'])}]" for m in ms})), ' '.join(kinds), len(certain), cls, why])
