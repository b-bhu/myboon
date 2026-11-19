# Labels and work flow

Use the repository's [canonical label list](../../.github/labels.md).

- `new`: a raw idea or bug. Nobody works on it.
- `grooming`: Bibhu and the CTO shape it until it fits the [agent-ready template](../../.github/ISSUE_TEMPLATE/agent-ready.md). The CPO answers product questions.
- `agent-ready`: any developer agent picks the top issue. Nobody routes it by name. The issue's Where section says the area.
- Pull request: one issue, one PR with `Closes #n`. After CI is green, the CTO reviews with comments only. DB Guy also reviews any migration. The UX Engineer reviews a PR that changes the UI. Bibhu merges.
- `blocked`: the agent hit its retry cap, or the issue is wrong. It goes back to grooming.

`needs-bucket` stays for work that touches money, wallets, the database or migrations. Keep it through review. Bibhu alone merges.

Do not route work to Frontend Dev, Backend Dev, or a `ready:*` label. Older `agent:*` labels stay retired.

`agent-ready` does not bypass the computer's safety approval cards: if a task hits one, the bot adds `blocked` and asks Bibhu in its own direct chat.

Apply a DB migration only after Bibhu explicitly says yes on the issue; a merged PR alone is not approval.

For frontend work, land shared API types in `packages/shared` in their own small PR before frontend work starts. Link that PR as a dependency in the issue.

Issues don't carry a build or release checklist. Bibhu handles app builds, version bumps, device testing and dApp Store updates by hand at release.

When a spec gets `spec-approved`, and when a `needs-bucket` PR merges, the acting bot posts a one-line comment starting with `Decision:` on the spec PR, issue or PR so Ledger can log it to Notion.
