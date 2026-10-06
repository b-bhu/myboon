# Home redesign references for local and remote development

These versioned files are the handoff for [#301 Home layout redesign](https://github.com/b-bhu/myboon/issues/301), [#302 Feed](https://github.com/b-bhu/myboon/issues/302), [#303 Apps](https://github.com/b-bhu/myboon/issues/303), [#304 Wallet](https://github.com/b-bhu/myboon/issues/304) and [#305 Swap](https://github.com/b-bhu/myboon/issues/305). No laptop-only ZIP is required.

## Choose the current reference

- **Feed:** open `index.html?nav=feed`. Calendar is expanded, full width, split 50/50, with a 250px reference height; Smart wallet activity follows below it.
- **Apps:** open `index.html?nav=apps`. This is the two-column launcher, not application interiors.
- **Wallet and Swap:** open `wallet-inline.html`. Add `?embed=1` to hide the desktop notes. The approved design has a yellow upper section, dark inline composer, compact portfolio and a raised markets panel with 14% top corners. Spot/Perps/Meteora sits inside the panel.
- The Wallet in `index.html`, its Swap sheet, and `swap-concept-a/b/c.html` are historical comparisons. They are retained only for context and existing reference navigation.

Read the live GitHub issues for current scope and ownership. This reference branch contains documentation and mock assets, not the native implementation. Keep working on your implementation branch.

## Fetch from any existing repository checkout

Fetch the dedicated reference branch and extract only its mock directory into a fresh temporary directory. This does not switch branches or overwrite your working tree:

```sh
git fetch https://github.com/b-bhu/myboon.git codex/home-redesign-references-301
myboon_reference_commit=$(git rev-parse FETCH_HEAD)
myboon_reference_dir=$(mktemp -d)
git archive "$myboon_reference_commit" docs/mockups/home-redesign | tar -x -C "$myboon_reference_dir"
printf '%s\n' "$myboon_reference_dir/docs/mockups/home-redesign"
```

For the exact approved snapshot, use the immutable commit SHA pinned in the issue's Desired behavior section instead of a moving branch tip. The issue includes a complete command block for that snapshot.

For one source file without extraction:

```sh
git show "$myboon_reference_commit":docs/mockups/home-redesign/wallet-inline.html
```

All local CSS, JavaScript, SVG and PNG dependencies are included. A developer with a browser can open the HTML directly; no build, installation or server is required for the static mock. A headless VPS can inspect the source but cannot thereby claim visual/device verification. Existing policy restrictions on browser access still apply; do not bypass them by starting a server.

## Interpret the mock correctly

Quotes, prices, balances, account addresses, scheduled events, wallet activity and market charts are fixtures. No signing, transfer or execution is connected. Native implementation must consume existing verified data/execution contracts and retain the unavailable states documented in the issues.

Read [README.md](README.md) for design details and historical verification limits. The issue-writing format is in the repository's `.github/ISSUE_TEMPLATE/implementation.md`, with corresponding guidance in `AGENTS.md`, `CLAUDE.md` and `.agents/skills/write-issue/SKILL.md`.

This publication fixes artifact availability. It does not complete implementation acceptance, certify native layout or authorize servers, deployment or live fund transfers.
