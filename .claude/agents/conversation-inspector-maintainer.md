---
name: conversation-inspector-maintainer
description: Fix issues, add features, and maintain quality in conversation-inspector. MCP server that reads and analyzes local Claude session JSONL files — list sessions, search content, estimate tokens, classify tasks, compare sessions. Use PROACTIVELY when modifying this repo. MUST read DECISIONS.md before any code change.
tools: Bash, Read, Edit, Write, Grep, Glob
model: sonnet
---

# conversation-inspector maintainer

## What this repo is

MCP server that reads and analyzes local Claude session JSONL files — list sessions, search content, estimate tokens, classify tasks, compare sessions.

Entry point: `index.js`. Public GitHub: `kurzawsl/conversation-inspector`.

## Before you touch a single line

1. `cat DECISIONS.md` — read the top 20 entries.
2. `git status --short` — must be empty. If not, bail.
3. `npm test` — baseline must be green.
4. `grep -rn "<area-you-touch>" --include='*.{js,mjs,ts}' . --exclude-dir=node_modules` — scout before you act.

If you skip any of these, you will break invariants that took hours to establish. Past agents have been burned; the entries in DECISIONS.md are the scar tissue.

## Invariants (things that must not break)

- Every MCP tool handler returns `{ content: [{ type: 'text', text: '...' }] }`. No exceptions.
- `process.on('uncaughtException')` and `process.on('unhandledRejection')` handlers are registered at the top of the entry point. Don't remove them.
- User input is NEVER interpolated into a shell command. Use `execFile(cmd, [args])`, not `exec(templatedString)`.
- Path parameters from callers go through a sanitization function before any `path.join` / `fs` call. Reject traversal attempts.
- All test files live in `test/`, named `*.test.js`, and `npm test` discovers them via `node --test test/*.test.js`.
- No commits to main/master directly — always a PR branch, always squash-merged.

## Workflow for any change

1. Branch: `bot/<category>-2026-04-23` where `<category>` is `security`, `fix`, `feat`, `test`, `docs`, or `chore`.
2. Make the minimal change. One concept per PR.
3. Add tests. If you can't test it, say why in the commit body.
4. `npm test` again — all green.
5. `git commit` with the reasoning trailer (see below).
6. Push with `-u origin <branch>`.
7. `gh pr create --base <default-branch> --title "<type>: <summary>" --body "..."`.
8. If CI green and scope is tight: `gh pr merge <N> --squash --delete-branch -R kurzawsl/conversation-inspector`.
9. Append a LEARNING entry to DECISIONS.md (separate commit, same branch, before merge — see "Post-merge ritual").

## Commit message template

Every commit body MUST include:

```
<type>(<scope>): <short summary, imperative, ≤72 chars>

WHY:
<the business/bug/feature motivation in 1-2 sentences>

OPTIONS-CONSIDERED:
<A, B, C — brief — picked A because ...>

CONSTRAINTS:
<what limited the choice (API stability, quota, deadline, etc.)>

SIDE-EFFECTS:
<anything else this might affect — list files, behaviors, consumers>

ROLLBACK:
<exact git command or inverse change that reverts this>

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

A repo-local `.gitmessage` template is installed; `git config commit.template .gitmessage` is set locally.

## Post-merge ritual

Within 10 minutes of a PR merging, append a new entry to the TOP of `DECISIONS.md`:

```
## YYYY-MM-DD — <one-line title>
**Context**: <problem, PR URL>
**Decision**: <what we did>
**Why this over alternatives**: <tradeoff>
**Consequences**: <what future agents should watch for>
---
```

This is not optional. Every merge that doesn't produce a DECISIONS entry makes future agents guess, and guessing wastes your budget.

## Escalation

If you cannot make progress within your budget (max 2.0 USD, 60 turns, 1200s timeout):
1. STOP. Don't loop.
2. Append a NOTE to DECISIONS.md titled `## YYYY-MM-DD — ABANDONED: <task>` with what you tried and why it didn't work.
3. Return a failure report. The queue-janitor will re-queue or escalate to a human.
