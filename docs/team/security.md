# Security and operations

- Never put secrets in code, chat or GitHub (including issues and PRs). Do not read or print any `.env` file. If credentials are needed, use the authorized runtime mechanism; do not copy them into a handoff.
- Use `/home/box/bin/vps` for VPS runtime checks and deploys. Approval is required before making VPS changes. Do not access the VPS by another route.
- Treat database, wallet and money-related work as `needs-bucket` work. Bucket reviews it and remains the only merger.
- Use Codex CLI first. Ollama Cloud is the default-model fallback. Do not use other model providers.

If required access is missing, stop before an operational change and record the missing access or approval in the issue. Do not expose credentials while diagnosing a failure.
