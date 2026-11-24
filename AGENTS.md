# Repository instructions

Read [CLAUDE.md](CLAUDE.md) for project communication, server-permission and scoped-verification rules.

## Writing GitHub issues

For every new issue or substantial issue rewrite, follow the [issue-writing skill](.agents/skills/write-issue/SKILL.md) and use the [agent-ready issue template](.github/ISSUE_TEMPLATE/agent-ready.md). This is the default for features, bugs and redesigns unless the user explicitly requests another format.

Keep these sections in order: **Goal** (with **Kind**: UI, Backend or Both), **Current behavior**, **Desired behavior** (Behavior contract, Look for UI, Spec for backend), **Scope**, **Not in this unit**, **Must preserve**, **Dependencies**, **Acceptance checklist**, **Tests**, **Open decisions**, **Pre-flight**. The template is the canonical copy; historical issues using other headings do not override it. The issue is the factory's complete input: the builder builds exactly it and the peer reviewer scores the PR against its acceptance checklist. For UI, the mock is the look and the issue is the behavior contract. State every number once, list leftovers under Not in this unit, and keep Open decisions at none before `agent-ready`. Why each section exists: [Agent-ready issue template (wiki)](https://github.com/b-bhu/myboon/wiki/Agent-ready-Issue-Template). How the factory uses the issue: [Software Factory (wiki)](https://github.com/b-bhu/myboon/wiki/Software-Factory).

Write for a developer or agent who has not seen this conversation. Include the relevant decisions, authoritative design/reference, affected components, ownership/dependencies, exclusions and existing contracts. Distinguish working functionality from mock data, planned functionality and missing access.

Write acceptance items as yes/no checks that can be answered from the diff, the tests or the mock frame (Given/when/then is fine), including relevant loading, unavailable, error and retry states. Specify scoped tests, setup/fixtures and permissions. CI is the gate; there is no device test and no screenshot requirement. Scale detail to the work; do not add irrelevant scenarios or assume that a local mock is accessible to another developer.

Implementation references must work from a fresh checkout or remote VPS. Prefer commit-pinned repository links with exact paths and fetch/extraction instructions. A laptop path or `/tmp` ZIP is an optional convenience, never the only required handoff. Before calling an issue ready, verify retrieval of its required artifacts; if publication/access is unavailable, name the missing dependency explicitly.
