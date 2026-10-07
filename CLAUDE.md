# How to talk to me

Talk like we're in a meeting room, debugging together out loud. Not like a report.

- Plain, spoken sentences. If you wouldn't say it out loud to someone across a table, don't write it.
- No jargon dumps, no stacking three technical terms into one sentence to sound precise. Say the plain-English version first. If a technical term is genuinely needed, introduce it once, simply.
- Skip the play-by-play of what you checked, grepped, or read. I don't need "let me trace X" or "confirming Y" — just tell me what you found and what it means.
- Say the conclusion first, then back it up in a sentence or two if needed. Don't make me read four paragraphs to get to the point.
- It's fine to be uncertain out loud ("I think it's X, not 100% sure") instead of hedging with long qualifier sentences.
- Short is better than thorough. If it can be one sentence, make it one sentence.

This is a general communication preference, not specific to any one topic (debugging, planning, whatever) — it applies to how you talk to me across the board in this repo.

# Local servers require permission

- Never start, restart, or launch any local server without the user's explicit permission. This includes Expo/Metro, web previews, development servers, API servers, and local database servers.
- A request to review, inspect, test, or fix something does not grant permission to start a local server. Ask first unless the user has explicitly authorized it in the current conversation.
- Prefer source inspection and lightweight checks. The user's laptop has limited resources.
- When asked to stop a server, stop only the server and child processes you started. Leave the user's existing servers running.

# Keep tests and typechecks scoped

- Run tests and typechecks only when needed to verify the work at hand. Do not run them routinely after every action or for documentation-only edits.
- Use the smallest valid, isolated scope: the affected tests for the behavior being changed, and the relevant module or package for typechecks.
- Never run full-repository test suites or broad typechecks unless the user explicitly requests or permits them. If a scoped check is unavailable, explain that and ask before running a broader one.
- Once relevant checks pass, do not repeat them unless new changes, failures, or unresolved concerns justify another run.

# Writing GitHub issues

- For every new issue or substantial issue rewrite, use the [implementation issue template](.github/ISSUE_TEMPLATE/implementation.md) and follow the [issue-writing skill](.agents/skills/write-issue/SKILL.md), unless the user explicitly requests another format.
- Keep the template's eight sections in order: Goal, Current behavior, Desired behavior, Scope, Must preserve, Acceptance scenarios, Verification, Completion evidence. This template supersedes older issue formats.
- Make the issue understandable without the chat: include decisions, applicable design references, affected components, ownership/dependencies, exclusions and preserved contracts. Distinguish actual functionality from prototypes, fixtures and future work; identify references that are not accessible to the recipient.
- Write observable Given/when/then scenarios with relevant loading, unavailable, error and retry cases. Specify scoped tests, UI/device checks, setup/fixtures, permissions and completion evidence. State what was actually checked and what remains unverified; do not present planned verification as completed work.
- Make required implementation references accessible from a fresh checkout or remote VPS: prefer commit-pinned repository links and exact fetch/extraction instructions, then verify retrieval. Local paths and `/tmp` ZIPs must not be the only handoff. If access/publication is unavailable, record the missing dependency instead of calling the issue ready.
