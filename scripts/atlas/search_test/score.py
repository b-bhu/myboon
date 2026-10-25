#!/usr/bin/env python3
"""#443 scorer: per query, top 5 + 1 cold + 10 warm EXPLAIN ANALYZE runs. Writes results.md, plans.txt."""
import csv, json, subprocess, sys, pathlib, statistics
qfile, out = sys.argv[1], pathlib.Path(sys.argv[2]); ps = sys.argv[sys.argv.index('--') + 1:]
lit = lambda s: "'" + s.replace("'", "''") + "'"
def sql(q):
    return subprocess.run(ps + ['-At', '-F', '\t', '-c', q], check=True, capture_output=True, text=True).stdout
rows, plans, all_ms = [], [], []
for r in csv.DictReader(open(qfile), delimiter='\t'):
    top = [l.split('\t') for l in sql(f"select * from search_test.search({lit(r['query'])}, 5)").splitlines()]
    slugs = [t[1] for t in top]
    pos = slugs.index(r['expected_shelf']) + 1 if r['expected_shelf'] in slugs else None
    ms = []
    for i in range(11):
        p = json.loads(sql(f"explain (analyze, buffers, format json) select * from search_test.search({lit(r['query'])}, 5)"))[0]
        if i: ms.append(p['Execution Time'] + p['Planning Time'])
    plans.append(f"## {r['n']}. {r['query']}\n" + sql(f"explain (analyze, buffers) select * from search_test.search({lit(r['query'])}, 5)"))
    all_ms += ms
    rows.append((r, slugs, pos, statistics.quantiles(ms, n=20, method='inclusive')[18], max(ms)))
h1 = sum(p == 1 for _, _, p, _, _ in rows); h5 = sum(p is not None for _, _, p, _, _ in rows)
p95 = statistics.quantiles(all_ms, n=20, method='inclusive')[18]; mx = max(all_ms)
ok = h1 >= 16 and h5 >= 19 and p95 <= 50 and mx <= 100
L = ['| # | kind | query | expected | hit@1 | hit@5 (pos) | top 5 | p95 ms | max ms |', '|---|---|---|---|---|---|---|---|---|']
for r, slugs, pos, q95, qmx in rows:
    L.append(f"| {r['n']} | {r['kind']} | {r['query'][:70]} | `{r['expected_shelf']}` | {'Y' if pos == 1 else 'N'} | {'Y (' + str(pos) + ')' if pos else 'N'} | {', '.join(slugs)} | {q95:.2f} | {qmx:.2f} |")
L.append(f"\n**hit@1 {h1}/20 (bar 16), hit@5 {h5}/20 (bar 19), p95 {p95:.2f} ms (bar 50), max {mx:.2f} ms (bar 100), over 10 warm runs x 20 queries -> {'PASS' if ok else 'FAIL'}**")
(out / 'results.md').write_text('\n'.join(L) + '\n'); (out / 'plans.txt').write_text('\n'.join(plans))
print('\n'.join(L))
