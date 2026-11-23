---
name: issue-visual
description: Draw one dark-theme visual for an issue or a group of issues, using the real mock frame (the master UI) with numbered markers for every Done-means line. Use when grooming or discussing a UI ticket, when an issue needs its change map, or when reviewing a PR against its requirement.
---

# Issue visual

One picture that shows, on the real mock screen, what a ticket changes, removes, keeps, or builds from fresh. It replaces a wall of Done-means text, which is where misses hide.

## What you produce

A single HTML file, dark theme, in this layout:

- Left: the real mock frame (not a redraw), with a numbered marker on the part each Done-means line touches.
- Right: one card per marker: what it is, its kind, the issue number, and what is in the code today.
- Legend: **new** (build from fresh), **change**, **remove**, **keep** (must not change).

Reference output: build it with `build_visual.py` in this folder.

## Steps

1. **Read the sources.** The issue body (Done means, Must preserve, Where), the wiki page for the module, and the mock. Read the code only for the "today" line of each card.
2. **Pick the mock frame.** Use the LOCKED mock revision named in the issue (for Wallet: `37e0a51`, branch `chore/wallet-one-screen-prd`). Do not use the file on `main` unless the issue says it is current: it can be an older version. Set `mock_rev` in the spec. Pick the frame by `frame_index` (its `data-i`; group captions list them in order).
3. **One marker per line.** Every Done-means line becomes a marker. Every Must-preserve line becomes a `keep` marker. A line with no frame in the mock gets a marker with no `anchor` and the card says "No frame in the mock": that is a design gap, raise it.
4. **Anchor by selector,** not pixels (`.wtop`, `.seg`, `.composer`). Markers follow the real layout. Use `outline` to box an area, `ghost` to draw something that should disappear.
5. **Build:** `python3 -I build_visual.py spec.json out.html`. It dumps the mock with headless Chrome (needs Chrome; no server is started), so run it on the laptop.
6. **Check it yourself:** screenshot the output with headless Chrome and look. Markers must land on what they name and not hide each other.
7. **File it.** Link the file from the issue. Do not commit it unless asked.

## Rules

- The picture is the mock, never a drawing from memory. If the frame is wrong the picture is wrong.
- Say what you did not check ("Not checked on a phone") in the card. Never imply a check you did not do.
- One frame per picture. If a ticket spans several frames, make one picture per frame.
- Keep card text to a sentence. Detail belongs in the issue.

## Reviewer use (QA as a reviewer)

Same picture, second pass. The reviewer reads the PR diff (only the changed files) against the requirement and the picture, then marks each marker pass, fail or not checked, with the file and line behind the verdict. A failing or unchecked marker blocks sign-off. A phone check is separate and still needed for anything the code cannot show (layout, lag).
