# Labels and work flow

Use the repository's [canonical label list](../../.github/labels.md). The full picture, with diagrams, is on the wiki: [Software Factory](https://github.com/b-bhu/myboon/wiki/Software-Factory).

```
new → grooming → agent-ready → building → pr-ready-to-review → pr-ready-to-merge → CTO merges
                      └──────────── blocked (exit; never back to grooming)
```

- `new`: a raw idea or bug. Nobody works on it.
- `grooming`: Bibhu and the CTO shape it until it fits the [agent-ready template](../../.github/ISSUE_TEMPLATE/agent-ready.md) and its pre-flight is all yes. Open decisions must be none. The CPO answers product questions.
- `agent-ready`: the issue is the factory's complete input. Any developer agent picks the top issue. Nobody routes it by name.
- `building`: the factory builder has claimed it.
- `pr-ready-to-review`: one issue, one PR with `Closes #n`. The peer reviewer scores the PR against the issue (two apples: what was asked, what was delivered), 1-10. A send-back fixes only the miss, on the same PR. At most 2 review rounds.
- `pr-ready-to-merge`: the reviewer signed off at 10 on the current head and CI is green. The CTO merges.
- `blocked`: an agent stopped because the issue is wrong or incomplete, or the retry cap was hit, with a three-sentence comment (problem, proposed fix, next step). The issue keeps `agent-ready` and never goes back to `grooming`: the CTO fixes it in place and removes `blocked`, splits it, or closes it.

There is no device-test stage and no QA label. Agents never merge, push to `main` or deploy.

`needs-bucket` stays for work that touches money, wallets, the database or migrations. Keep it through review. Bibhu alone merges.

Do not route work to Frontend Dev, Backend Dev, `in-progress` or a `ready:*` label. Older `agent:*` labels stay retired.

`agent-ready` does not bypass the computer's safety approval cards: if a task hits one, the bot adds `blocked` and asks Bibhu in its own direct chat.

Apply a DB migration only after Bibhu explicitly says yes on the issue; a merged PR alone is not approval.

For frontend work, land shared API types in `packages/shared` in their own small PR before frontend work starts. Link that PR as a dependency in the issue.

Issues don't carry a build or release checklist. Bibhu handles app builds, version bumps and dApp Store updates by hand at release.

When a spec gets `spec-approved`, and when a `needs-bucket` PR merges, the acting bot posts a one-line comment starting with `Decision:` on the spec PR, issue or PR so Ledger can log it to Notion.
