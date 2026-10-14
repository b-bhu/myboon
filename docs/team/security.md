# Security and operations

- Never put secrets in code, chat or GitHub (including issues and PRs). Do not read or print any `.env` file. If credentials are needed, use the authorized runtime mechanism; do not copy them into a handoff.
- Use `/home/box/bin/vps` for VPS runtime checks and deploys. Approval is required before making VPS changes. Do not access the VPS by another route.
- Treat database, wallet and money-related work as `needs-bucket` work. Bucket reviews it and remains the only merger.
- Use Codex CLI (gpt-6-luna, high effort) for coding, design, debugging and reviews; use GLM (glm-5.3-flash) on Ollama Cloud via Hermes for search and research. Each is the other's fallback only if one is unavailable. Always run `codex exec ... </dev/null`. Do not use other model providers.

If required access is missing, stop before an operational change and record the missing access or approval in the issue. Do not expose credentials while diagnosing a failure.
