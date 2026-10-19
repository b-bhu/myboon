#!/usr/bin/env python3
"""#342 PR-4: read-only check. Lists existing live entity pairs whose keys would
collide once legal suffixes (Inc, Ltd, Corp, Labs) are stripped at compare time.
Stored name_key is unchanged; this only informs review. Input: review-export.json."""
import json, sys
from collections import defaultdict
from kinds import compare_key, kind_v1
g = defaultdict(list)
for r in json.load(open(sys.argv[1])):
    k = compare_key(r['name'])
    if k: g[k].append(r)
for k, rs in sorted(g.items()):
    keys = {r['name_key'] for r in rs}
    if len(keys) > 1:
        print(k + ': ' + ' | '.join(f"{r['name']} ({r['id']}, {kind_v1(r['type'])}, items {r['live_items']})" for r in rs))
