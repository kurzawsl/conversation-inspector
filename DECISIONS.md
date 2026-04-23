# conversation-inspector — Decisions Log

This file captures *why*, not *what*. Read before opening a PR.
Append new entries at the TOP. Keep entries ≤15 lines.

## 2026-04-23 — security: harden inputs — opt-in dangerouslySkipPermissions, date trav
**Context**: Unspecified external risk or critic finding (see PR and git log for details). (commit c701293)
**Decision**: Applied the security fix described in the PR title.
**Why this over alternatives**: Defense in depth — the alternative (doing nothing / accepting risk) was not viable once the finding surfaced.
**Consequences**: Any caller passing previously-accepted unsafe input will now get an error. Callers must update to valid inputs.
---

## 2026-04-23 — docs: README polish — badges, install snippet, example output
**Context**: README lacked install instructions, examples, or badges; repo looked abandoned from the outside. (commit d6fc9c3)
**Decision**: Polished README with badges, install snippet, example output.
**Why this over alternatives**: Public repos are judged by their cover; professional docs are a cheap signal.
**Consequences**: Future README edits should match the tone + structure. Don't degrade it.
---

## 2026-04-23 — chore: add process.uncaughtException + unhandledRejection handlers
**Context**: None of the MCP entry points surfaced uncaughtException/unhandledRejection. Rejected promises silently killed the process. (commit 3e22769)
**Decision**: Registered both handlers at the top of the entry point. They log JSON to stderr and process.exit(1).
**Why this over alternatives**: Silent death leaves Claude Code guessing; explicit stderr + non-zero exit is loud and debuggable.
**Consequences**: If you throw from inside an MCP handler AND the SDK doesn't catch it, the whole server dies. That's intentional — better loud than zombied.
---

## 2026-04-23 — chore: prep for public release
**Context**: Repo was private; going public required LICENSE, clean package.json, no committed secrets. (commit c75a828)
**Decision**: Added MIT LICENSE, polished package.json (description, author, repository, keywords), tightened .gitignore.
**Why this over alternatives**: Public-repo hygiene is a gate — any secret in history is permanent exposure.
**Consequences**: Future commits must not add secrets. .env is gitignored; credentials must come from env vars.
---

## 2026-04-23 — ci: add unit tests, extract pure helpers to lib/, add GitHub Actions wor
**Context**: Repo had no CI before this commit. Every push was merged without automated verification. (commit 3d025d6)
**Decision**: Added GitHub Actions workflow + unit tests extracted into lib/. Enforced via npm test.
**Why this over alternatives**: Manual review alone didn't catch regressions; Tier-1 repos get full CI, Tier-2 smoke-only.
**Consequences**: All future PRs run on Node 20+22 matrix. Breaking changes to shared test harness block merges.
---

