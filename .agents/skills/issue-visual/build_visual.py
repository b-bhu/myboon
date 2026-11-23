#!/usr/bin/env python3
"""Build a dark-theme issue visual from the REAL mock (docs/design/wallet.html).

Usage: python3 -I build_visual.py spec.json out.html

spec.json:
{
  "title": "Wallet shell",
  "subtitle": "Issues #801 to #804",
  "mock": "docs/design/wallet.html",            # path, relative to the repo root
  "mock_rev": "37e0a51",                         # git revision of the LOCKED mock (the file on main can be older)
  "dom_cache": "/tmp/mock-dom.html",             # optional: reuse a Chrome dump
  "chrome": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "frame_index": 0,                              # which mock frame (its data-i), or "frame_state": {...} (its data-s)
  "markers": [
    {"n": 1, "kind": "change", "anchor": ".wtop", "label": "Gold header",
     "today": "Not checked on a phone", "issue": 801, "outline": true},
    {"n": 2, "kind": "remove", "anchor": ".composer", "label": "Old Swap dropdown",
     "today": "Shows in the build", "issue": 802, "ghost": "Swap ⌄"}
  ]
}
Reviewer mode: add "verdict": "pass" | "fail" | "unchecked" and "evidence": "path/file.tsx:42" to a marker.
  The marker then shows a tick, a cross or a question mark, and the card shows the verdict and the evidence.
kind: new (built from fresh) | change | remove | keep (must not change).
anchor: a CSS selector inside the frame; markers are placed by script, so they follow the real layout.
        Add "all": true with "outline" to box every element the selector matches (for example both columns).
        Leave anchor out when the mock has no frame for it; the card then says so.
"""
import json, re, subprocess, sys, html, pathlib

spec = json.load(open(sys.argv[1], encoding="utf-8"))
out = sys.argv[2]
root = pathlib.Path(__file__).resolve().parents[3]
mock = (root / spec.get("mock", "docs/design/wallet.html")).resolve()
rev = spec.get("mock_rev")
if rev:
    import tempfile
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="issue-visual-"))
    rel = str(mock.relative_to(root))
    (tmp / "wallet.html").write_text(subprocess.run(["git", "-C", str(root), "show", f"{rev}:{rel}"],
                                      capture_output=True, text=True, check=True).stdout, encoding="utf-8")
    mock = tmp / "wallet.html"

cache = spec.get("dom_cache")
if cache and pathlib.Path(cache).exists():
    dom = pathlib.Path(cache).read_text(encoding="utf-8")
else:
    chrome = spec.get("chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    dom = subprocess.run([chrome, "--headless=new", "--disable-gpu", "--no-first-run",
                          "--virtual-time-budget=4000", "--dump-dom", mock.as_uri()],
                         capture_output=True, text=True, timeout=120).stdout
    if cache:
        pathlib.Path(cache).write_text(dom, encoding="utf-8")

want = spec.get("frame_state", {})
frame = None
if "frame_index" in spec:
    pat = r'<div class="phone[^"]*"[^>]*data-i="%d"[^>]*>' % spec["frame_index"]
else:
    pat = r'<div class="phone"[^>]*data-s="([^"]*)"[^>]*>'
for m in re.finditer(pat, dom):
    if "frame_index" in spec or json.loads(html.unescape(m.group(1))) == want:
        i, depth = m.start(), 0
        for t in re.finditer(r'<div\b|</div>', dom[i:]):
            depth += 1 if t.group(0) == '<div' else -1
            if depth == 0:
                frame = dom[i:i + t.end()]
                break
        break
if not frame:
    sys.exit(f"No mock frame for {spec.get('frame_index', want)}")

styles = "\n".join(re.findall(r'<style[^>]*>.*?</style>', dom, flags=re.S))
colors = {"new": "#1D9E75", "change": "#EF9F27", "remove": "#E24B4A", "keep": "#888780"}
words = {"new": "Build from fresh", "change": "Change", "remove": "Remove", "keep": "Must not change"}
cards = ""
for mk in spec["markers"]:
    c = colors[mk["kind"]]
    iss = f' · #{mk["issue"]}' if mk.get("issue") else ""
    if not mk.get("anchor"): mk["today"] = (mk.get("today", "") + " (No frame in the mock.)").strip()
    vd = mk.get("verdict")
    vtxt = ""
    if vd:
        vc = {"pass": "#1D9E75", "fail": "#E24B4A", "unchecked": "#888780"}[vd]
        ev = f' · {html.escape(mk["evidence"])}' if mk.get("evidence") else ""
        vtxt = f'<p class="vv" style="color:{vc}">{vd.capitalize()}{ev}</p>'
    cards += (f'<div class="vc"><span class="vb" style="background:{c}">{mk["n"]}</span><div>'
              f'<b>{html.escape(mk["label"])}</b><small style="color:{c}">{words[mk["kind"]]}{iss}</small>'
              f'<p>{html.escape(mk.get("today",""))}</p>{vtxt}</div></div>')
legend = "".join(f'<span><i style="background:{colors[k]}"></i>{words[k]}</span>' for k in colors)

page = f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{html.escape(spec["title"])}</title>{styles}
<style>
html,body{{background:#05161d!important;color:#E6F1F5;margin:0;padding:0;height:auto!important;overflow:auto!important}}
.vp{{max-width:880px;margin:0 auto;padding:24px 16px;font-family:system-ui,sans-serif}}
.vp h1{{font:500 22px system-ui;margin:0 0 4px}} .vp .sub{{color:#6B95A1;font-size:13px;margin:0 0 16px}}
.vg{{display:grid;grid-template-columns:390px 1fr;gap:24px;align-items:start}}
@media(max-width:860px){{.vg{{grid-template-columns:1fr}}}}
#vf{{position:relative;width:390px;height:844px;border:1px solid #185A70;border-radius:24px;overflow:hidden}}
#vf .phone{{position:absolute;left:0;top:0;margin:0}}
.vc{{display:flex;gap:12px;background:#0B1A22;border:1px solid #185A70;border-radius:12px;padding:12px;margin:0 0 10px}}
.vc b{{display:block;font:500 15px system-ui}} .vc small{{font:500 12px system-ui}} .vc p{{margin:4px 0 0;color:#9CB8C2;font-size:13px}}
.vb{{flex:0 0 26px;height:26px;border-radius:50%;display:grid;place-items:center;color:#05161d;font:700 13px system-ui}}
.vl{{display:flex;gap:14px;flex-wrap:wrap;margin:6px 0 0;color:#9CB8C2;font-size:12px}} .vl i{{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px}}
.vv{{font-weight:500}}
.vmk{{position:absolute;z-index:9000;min-width:24px;height:24px;padding:0 6px;box-sizing:border-box;border-radius:12px;display:grid;place-items:center;color:#05161d;font:700 12px system-ui;box-shadow:0 0 0 2px #05161d}}
.ol{{position:absolute;z-index:8999;border:2px dashed;border-radius:6px;pointer-events:none}}
.gh{{position:absolute;z-index:8999;border:2px dashed #E24B4A;background:#E24B4A33;color:#FFD1D0;font:600 13px system-ui;padding:3px 8px;border-radius:6px;pointer-events:none}}
</style></head><body><div class="vp"><h1>{html.escape(spec["title"])}</h1>
<p class="sub">{html.escape(spec.get("subtitle",""))} · the frame is the real mock, not a redraw</p>
<div class="vg"><div id="vf">{frame}</div><div>{cards}<div class="vl">{legend}</div></div></div></div>
<script>
const M={json.dumps(spec["markers"])},C={json.dumps(colors)},f=document.getElementById('vf'),fr=f.getBoundingClientRect();
const used={{}};M.forEach(m=>{{if(!m.anchor)return;const a=f.querySelector(m.anchor);if(!a)return;const k=m.anchor,off=(used[k]=(used[k]||0)+1)-1;const r=a.getBoundingClientRect(),x=r.left-fr.left,y=r.top-fr.top;
 if(m.outline){{const o=document.createElement('div');o.className='ol';o.style.cssText=`left:${{x}}px;top:${{y}}px;width:${{r.width}}px;height:${{r.height}}px;border-color:${{C[m.kind]}}`;f.appendChild(o)}}
 if(m.all&&m.outline){{f.querySelectorAll(m.anchor).forEach((e,i)=>{{if(!i)return;const q=e.getBoundingClientRect(),o=document.createElement('div');o.className='ol';o.style.cssText=`left:${{q.left-fr.left}}px;top:${{q.top-fr.top}}px;width:${{q.width}}px;height:${{q.height}}px;border-color:${{C[m.kind]}}`;f.appendChild(o)}})}}
 if(m.ghost){{const g=document.createElement('div');g.className='gh';g.textContent=m.ghost;g.style.cssText=`left:${{x+8}}px;top:${{y+6}}px`;f.appendChild(g)}}
 const b=document.createElement('div');b.className='vmk';b.textContent=m.n+({{pass:' ✓',fail:' ✕',unchecked:' ?'}}[m.verdict]||'');b.style.cssText=`left:${{r.width<60?Math.max(4,x-6-off*28):Math.max(4,x+r.width-30-off*28)}}px;top:${{r.width<60?y-28:y+4}}px;background:${{C[m.kind]}}`;f.appendChild(b)}});
</script></body></html>"""
pathlib.Path(out).write_text(page, encoding="utf-8")
print("wrote", out, f"({len(page)//1024} KB)")
