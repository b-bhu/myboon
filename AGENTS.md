# Repository instructions

Read [CLAUDE.md](CLAUDE.md) for project communication, server-permission and scoped-verification rules.

## Writing GitHub issues

For every new issue or substantial issue rewrite, follow the [issue-writing skill](.agents/skills/write-issue/SKILL.md) and use the [implementation issue template](.github/ISSUE_TEMPLATE/implementation.md). This is the default for features, bugs and redesigns unless the user explicitly requests another format.

Keep these sections in order: **Goal**, **Current behavior**, **Desired behavior**, **Scope**, **Must preserve**, **Acceptance scenarios**, **Verification**, **Completion evidence**. The template is the canonical copy; historical issues using other headings do not override it.

Write for a developer or agent who has not seen this conversation. Include the relevant decisions, authoritative design/reference, affected components, ownership/dependencies, exclusions and existing contracts. Distinguish working functionality from mock data, planned functionality and missing access.

Use observable Given/when/then scenarios, including relevant loading, unavailable, error and retry states. Specify scoped tests, actual UI/device checks where needed, setup/fixtures, permissions and completion evidence. Clearly separate required verification from checks actually performed and state what remains unverified. Scale detail to the work; do not add irrelevant scenarios or assume that a local mock is accessible to another developer.

Implementation references must work from a fresh checkout or remote VPS. Prefer commit-pinned repository links with exact paths and fetch/extraction instructions. A laptop path or `/tmp` ZIP is an optional convenience, never the only required handoff. Before calling an issue ready, verify retrieval of its required artifacts; if publication/access is unavailable, name the missing dependency explicitly.
