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
