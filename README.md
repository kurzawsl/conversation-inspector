# conversation-inspector

[![CI](https://github.com/kurzawsl/conversation-inspector/actions/workflows/ci.yml/badge.svg)](https://github.com/kurzawsl/conversation-inspector/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

An MCP server that reads and analyzes local Claude session JSONL files — list sessions, search content, estimate tokens, classify tasks, compare sessions.

Claude Code stores every conversation as JSONL files under `~/.claude/projects/`. This server exposes those files as structured MCP tools so you can query your own session history from within any Claude conversation.

## Prerequisites

- Node.js 20+

## Installation

```bash
git clone https://github.com/kurzawsl/conversation-inspector.git
cd conversation-inspector
npm install
```

## Usage

Register the server in your Claude Code MCP config (`~/.claude.json`):

```json
{
  "mcpServers": {
    "conversation-inspector": {
      "command": "node",
      "args": ["/path/to/conversation-inspector/index.js"],
      "env": {}
    }
  }
}
```

The server reads JSONL files from `~/.claude/projects/` (or the path set in the `CLAUDE_PROJECTS_DIR` environment variable).

## Tools

### Session listing and reading
- **`list_sessions`** — List recent Claude conversation sessions with ID, project, timestamp, and turn count.
- **`get_session_summary`** — Get a detailed summary of a session: tools used, turns, duration, key decisions.
- **`get_session_tools`** — Get all tools called in a session with their inputs and outputs.
- **`get_session_messages`** — Get all user prompts and assistant responses from a session.
- **`get_session_timeline`** — Get a detailed timeline of all actions in a session with timestamps.
- **`visualize_session`** — Create an ASCII visualization of a conversation session.

### Search and analysis
- **`search_sessions`** — Search across all sessions for specific content, tool names, or errors.
- **`get_all_prompts`** — Extract all user prompts from sessions to understand work patterns.
- **`analyze_session_errors`** — Find errors, failures, and issues in a session.
- **`analyze_thinking_patterns`** — Analyze tool usage order, retries, and reasoning patterns in a session.
- **`analyze_tool_effectiveness`** — Analyze how effectively tools were used across sessions.
- **`get_conversation_insights`** — Deep insights from conversation patterns.

### Comparison and similarity
- **`compare_sessions`** — Compare two sessions: differences in approach, tools used, and outcomes.
- **`find_similar_sessions`** — Find sessions similar to a given session based on prompts and tools used.

### Statistics and reporting
- **`get_daily_statistics`** — Comprehensive stats for a day: sessions, tools, tokens, prompts.
- **`get_tool_usage_stats`** — Aggregated tool usage stats across all sessions.
- **`estimate_token_usage`** — Estimate token usage across sessions.
- **`generate_work_summary`** — Human-readable summary of all work done (useful for standups or EOD reports).
- **`save_daily_report`** — Save aggregated daily stats to a JSON file for historical tracking.
- **`identify_automation_opportunities`** — Analyze patterns to find repetitive tasks that could be automated.

### Process management (claude -p)
- **`get_claude_p_executions`** — Get recent non-interactive `claude -p` sessions spawned by other Claude instances.
- **`spawn_claude_process`** — Spawn a new `claude -p` process in background, returns immediately with a process ID. `dangerouslySkipPermissions` defaults to **false** — pass `true` to opt in.
- **`watch_processes`** — Get status of all running `claude -p` processes.
- **`get_process_progress`** — Get real-time progress of a specific `claude -p` process.
- **`get_process_output`** — Get the full output of a completed `claude -p` process.
- **`kill_process`** — Kill a running `claude -p` process.
- **`list_all_processes`** — List all processes (running and completed) with history.

### Security defaults

| Tool / Parameter | Default | Notes |
|------------------|---------|-------|
| `spawn_claude_process` → `dangerouslySkipPermissions` | `false` | Must be explicitly set to `true` to pass `--dangerously-skip-permissions` to claude |
| `save_daily_report` → `date` | today | Must match `YYYY-MM-DD`; any other format (including traversal payloads) is rejected |

### Example: generate a work summary

Request:
```json
{
  "tool": "generate_work_summary",
  "arguments": { "date": "2026-04-23" }
}
```

Response:
```
Work Summary — 2026-04-23
Sessions: 4  |  Total turns: 87  |  Tools called: 214

Top tools: Bash (91), Read (43), Edit (38), Write (22), Grep (20)

Projects worked on:
  • /home/user/myapp — refactored auth module, added JWT refresh
  • /home/user/scripts — automated backup rotation script

Estimated tokens: ~142,000
```

## Development

```bash
# Run tests (Node 20+ required)
npm test

# Start the MCP server directly
npm start
```

## License

MIT — see [LICENSE](LICENSE).
